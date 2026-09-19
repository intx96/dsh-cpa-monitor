/**
 * dsh-cpa-monitor — proxy-aware HTTP(S) client.
 *
 * Zero dependencies: only `node:` builtins, because a profile plugin installed
 * with `link:` keeps its own real path, so package resolution never walks up
 * into the profile's `node_modules`.
 *
 * Supports three transports, each entry in the candidate list being tried in
 * order until one answers:
 *   - `http://host:port`      HTTP CONNECT tunnel (optionally with Basic auth)
 *   - `https://host:port`     HTTP CONNECT tunnel over TLS to the proxy itself
 *   - `socks5(h)://host:port` SOCKS5 CONNECT (optionally RFC 1929 auth)
 *   - `null`                  a direct connection, appended as the last resort
 *
 * Content-Encoding is inflated with `node:zlib` when the peer ignores our
 * `accept-encoding: identity` hint.
 *
 * @module dsh-cpa-monitor/net
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** Methods with no request body, so no `content-length` is emitted for them. */
const BODYLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

/** Cap on a proxy handshake header block; anything larger is a broken peer. */
const MAX_HANDSHAKE_BYTES = 16384;

/** Normalize a transport failure into a short, UI-safe reason string. */
function reasonOf(error) {
	if (error instanceof Error) return error.code ?? error.message;
	return String(error);
}

/**
 * Parse one proxy specifier.
 * @param raw - `http://`, `https://`, `socks5://`, or `socks5h://` URL (scheme optional).
 * @returns the parsed transport, or undefined when the specifier is unusable.
 */
export function parseProxy(raw) {
	const text = String(raw ?? "").trim();
	if (text === "") return undefined;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	let url;
	try {
		url = new URL(withScheme);
	} catch {
		return undefined;
	}
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	const port = url.port === "" ? (scheme.startsWith("socks") ? 1080 : scheme === "https" ? 443 : 8080) : Number(url.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "") return undefined;
	const auth = url.username === ""
		? undefined
		: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
	if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks") {
		return { raw: text, kind: "socks5", host, port, auth, tunnelTls: false };
	}
	if (scheme === "http" || scheme === "https") {
		return { raw: text, kind: "http", host, port, auth, tunnelTls: scheme === "https" };
	}
	return undefined;
}

/**
 * Buffered socket reader.
 *
 * Tunnel handshakes read exact frames off a socket that then carries unrelated
 * traffic; {@link SocketReader.detach} returns whatever was over-read so the
 * caller can push it back before the socket changes owners.
 */
class SocketReader {
	/** @param socket - the socket to read from. */
	constructor(socket) {
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.waiter = undefined;
		this.failure = undefined;
		this.onData = (chunk) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.notify();
		};
		this.onError = (error) => {
			this.failure = error;
			this.notify();
		};
		this.onClose = () => {
			this.failure ??= new Error("socket closed during handshake");
			this.notify();
		};
		socket.on("data", this.onData);
		socket.on("error", this.onError);
		socket.on("close", this.onClose);
	}

	/** Wake a pending read when more bytes (or a failure) arrived. */
	notify() {
		const waiter = this.waiter;
		if (waiter === undefined) return;
		this.waiter = undefined;
		waiter();
	}

	/** Detach every listener; the socket is handed to its final owner. */
	dispose() {
		this.socket.off("data", this.onData);
		this.socket.off("error", this.onError);
		this.socket.off("close", this.onClose);
	}

	/**
	 * Read exactly `count` bytes.
	 * @param count - byte count.
	 * @returns the bytes.
	 */
	async read(count) {
		while (this.buffer.length < count) {
			if (this.failure !== undefined) throw this.failure;
			await new Promise((resolve) => {
				this.waiter = resolve;
			});
		}
		const out = this.buffer.subarray(0, count);
		this.buffer = this.buffer.subarray(count);
		return out;
	}

	/**
	 * Read until `delimiter` (inclusive).
	 * @param delimiter - byte string to scan for.
	 * @returns everything up to and including the delimiter.
	 */
	async readUntil(delimiter) {
		for (;;) {
			const at = this.buffer.indexOf(delimiter);
			if (at !== -1) {
				const out = this.buffer.subarray(0, at + delimiter.length);
				this.buffer = this.buffer.subarray(at + delimiter.length);
				return out;
			}
			if (this.failure !== undefined) throw this.failure;
			if (this.buffer.length > MAX_HANDSHAKE_BYTES) throw new Error("proxy handshake header too large");
			await new Promise((resolve) => {
				this.waiter = resolve;
			});
		}
	}

	/**
	 * Release the socket and return over-read bytes to its incoming stream.
	 * @returns the socket, ready to carry tunnelled traffic.
	 */
	detach() {
		const { socket, buffer } = this;
		this.dispose();
		if (buffer.length > 0) socket.unshift(buffer);
		return socket;
	}
}

/**
 * Open a TCP (or TLS, for an `https://` proxy) connection to the proxy.
 * @param proxy - parsed proxy.
 * @param timeoutMs - connect timeout.
 * @param insecure - skip certificate verification for the proxy leg.
 * @returns the connected socket.
 */
function connectToProxy(proxy, timeoutMs, insecure) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			socket.destroy();
			reject(error);
		};
		const socket = proxy.tunnelTls
			? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host, rejectUnauthorized: !insecure })
			: net.connect({ host: proxy.host, port: proxy.port });
		socket.setTimeout(timeoutMs, () => onError(new Error(`proxy connect timeout (${proxy.raw})`)));
		const ready = proxy.tunnelTls ? "secureConnect" : "connect";
		socket.once(ready, () => {
			socket.setTimeout(0);
			socket.off("error", onError);
			resolve(socket);
		});
		socket.once("error", onError);
	});
}

/**
 * Tunnel to `host:port` through an HTTP CONNECT proxy.
 * @param socket - connected proxy socket.
 * @param host - target host.
 * @param port - target port.
 * @param proxy - parsed proxy (for Basic auth).
 * @param timeoutMs - handshake timeout.
 * @returns the tunnelled socket.
 */
async function httpConnect(socket, host, port, proxy, timeoutMs) {
	const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
	const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: keep-alive"];
	if (proxy.auth !== undefined) {
		const token = Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`, "utf8").toString("base64");
		lines.push(`Proxy-Authorization: Basic ${token}`);
	}
	socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`proxy CONNECT timeout (${proxy.raw})`)));
	const reader = new SocketReader(socket);
	try {
		socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		const head = (await reader.readUntil("\r\n\r\n")).toString("latin1");
		const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1] ?? 0);
		if (status !== 200) throw new Error(`proxy CONNECT rejected with HTTP ${status || "???"} (${proxy.raw})`);
		socket.setTimeout(0);
		return reader.detach();
	} catch (error) {
		reader.dispose();
		socket.destroy();
		throw error;
	}
}

/**
 * Tunnel to `host:port` through a SOCKS5 proxy (RFC 1928, RFC 1929 auth).
 * @param socket - connected proxy socket.
 * @param host - target host sent as a domain name when not an IP literal.
 * @param port - target port.
 * @param proxy - parsed proxy (for user/pass auth).
 * @param timeoutMs - handshake timeout.
 * @returns the tunnelled socket.
 */
async function socks5Connect(socket, host, port, proxy, timeoutMs) {
	socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`SOCKS5 timeout (${proxy.raw})`)));
	const reader = new SocketReader(socket);
	try {
		const methods = proxy.auth === undefined ? [0x00] : [0x00, 0x02];
		socket.write(Buffer.from([0x05, methods.length, ...methods]));
		const greeting = await reader.read(2);
		if (greeting[0] !== 0x05) throw new Error(`SOCKS5 bad version ${String(greeting[0])} (${proxy.raw})`);
		if (greeting[1] === 0xff) throw new Error(`SOCKS5 no acceptable auth method (${proxy.raw})`);
		if (greeting[1] === 0x02) {
			const user = Buffer.from(proxy.auth?.user ?? "", "utf8");
			const pass = Buffer.from(proxy.auth?.pass ?? "", "utf8");
			socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
			const authReply = await reader.read(2);
			if (authReply[1] !== 0x00) throw new Error(`SOCKS5 auth rejected (${proxy.raw})`);
		}
		const address = net.isIP(host) === 4
			? Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split(".").map(Number))])
			: net.isIP(host) === 6
				? Buffer.concat([Buffer.from([0x04]), Buffer.from(host.split(":").map((part) => Number.parseInt(part || "0", 16)).flatMap((word) => [word >> 8, word & 0xff]))])
				: (() => {
					const name = Buffer.from(host, "utf8");
					return Buffer.concat([Buffer.from([0x03, name.length]), name]);
				})();
		const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
		socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBytes]));
		const reply = await reader.read(4);
		if (reply[1] !== 0x00) throw new Error(`SOCKS5 CONNECT failed with code ${String(reply[1])} (${proxy.raw})`);
		const tail = reply[3] === 0x01 ? 4 + 2 : reply[3] === 0x04 ? 16 + 2 : (await reader.read(1))[0] + 2;
		await reader.read(tail);
		socket.setTimeout(0);
		return reader.detach();
	} catch (error) {
		reader.dispose();
		socket.destroy();
		throw error;
	}
}

/**
 * Establish a raw TCP connection to `host:port` through `proxy`.
 * @param proxy - parsed proxy.
 * @param host - target host.
 * @param port - target port.
 * @param options - timeout and TLS verification policy.
 * @returns the tunnelled socket.
 */
async function openTunnel(proxy, host, port, options) {
	const socket = await connectToProxy(proxy, options.timeoutMs, options.insecure);
	return proxy.kind === "socks5"
		? socks5Connect(socket, host, port, proxy, options.timeoutMs)
		: httpConnect(socket, host, port, proxy, options.timeoutMs);
}

/** `https.Agent` that tunnels every connection through one parsed proxy. */
class TunnelHttpsAgent extends https.Agent {
	/** @param options - proxy plus timeout/TLS policy. */
	constructor(options) {
		super({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
		this.tunnel = options;
	}

	/**
	 * Socket factory: tunnel, then run the TLS handshake over the tunnel.
	 *
	 * The handshake gets its own timer: a proxy that accepts TCP and then stops
	 * forwarding would otherwise hang the request until the peer gives up
	 * (observed at ~81s on a dead port).
	 *
	 * @param options - Node's per-connection options.
	 * @param callback - receives the TLS socket.
	 */
	createConnection(options, callback) {
		const { connectTimeoutMs } = this.tunnel;
		openTunnel(this.tunnel.proxy, options.host, options.port, { timeoutMs: connectTimeoutMs, insecure: this.tunnel.insecure }).then(
			(socket) => {
				const timer = setTimeout(() => socket.destroy(new Error(`TLS handshake timeout via ${this.tunnel.proxy.raw}`)), connectTimeoutMs);
				const secure = tls.connect({
					socket,
					servername: options.servername ?? options.host,
					rejectUnauthorized: !this.tunnel.insecure
				});
				secure.once("secureConnect", () => {
					clearTimeout(timer);
					callback(null, secure);
				});
				secure.once("error", (error) => {
					clearTimeout(timer);
					callback(error);
				});
			},
			(error) => callback(error)
		);
	}
}

/** `http.Agent` that tunnels every connection through one parsed proxy. */
class TunnelHttpAgent extends http.Agent {
	/** @param options - proxy plus timeout. */
	constructor(options) {
		super({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
		this.tunnel = options;
	}

	/**
	 * Socket factory: a plain tunnel, no TLS leg.
	 * @param options - Node's per-connection options.
	 * @param callback - receives the socket.
	 */
	createConnection(options, callback) {
		openTunnel(this.tunnel.proxy, options.host, options.port, {
			timeoutMs: this.tunnel.connectTimeoutMs,
			insecure: this.tunnel.insecure
		}).then((socket) => callback(null, socket), (error) => callback(error));
	}
}

/** Inflate a response body when the peer ignored `accept-encoding: identity`. */
function decodeBody(buffer, encoding) {
	const kind = String(encoding ?? "").split(",")[0].trim().toLowerCase();
	try {
		if (kind === "gzip" || kind === "x-gzip") return gunzipSync(buffer).toString("utf8");
		if (kind === "deflate") return inflateSync(buffer).toString("utf8");
		if (kind === "br") return brotliDecompressSync(buffer).toString("utf8");
	} catch (error) {
		throw new Error(`response body is ${kind} but could not be decoded: ${reasonOf(error)}`);
	}
	return buffer.toString("utf8");
}

/**
 * Perform one request over one explicit transport.
 * @param url - absolute target URL.
 * @param options - method, headers, body, transport, agent, and limits.
 * @returns status, headers, and decoded text body.
 */
function requestOnce(url, options) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const secure = target.protocol === "https:";
		const headers = { ...options.headers };
		if (options.body !== undefined && !BODYLESS.has(options.method)) {
			headers["content-length"] = Buffer.byteLength(options.body);
		}
		const request = (secure ? https : http).request(target, {
			method: options.method,
			headers,
			...(options.agent === undefined ? {} : { agent: options.agent }),
			...(secure ? { rejectUnauthorized: !options.insecure } : {})
		});
		request.setTimeout(options.timeoutMs, () =>
			request.destroy(new Error(`request timeout ${String(options.timeoutMs)}ms via ${String(options.label)}`))
		);
		request.once("error", (error) => {
			request.destroy();
			reject(error);
		});
		request.once("response", (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.once("error", reject);
			response.once("end", () => {
				try {
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: decodeBody(Buffer.concat(chunks), response.headers["content-encoding"])
					});
				} catch (error) {
					reject(error);
				}
			});
		});
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

/**
 * Build a sticky, self-healing HTTP client.
 *
 * Transport selection has three stages:
 *
 *  1. Once a transport has won, every request goes straight to it, over a
 *     cached keep-alive Agent (one tunnel + TLS handshake per connection,
 *     reused afterwards). A transient failure gets exactly one retry before
 *     the transport is reconsidered.
 *  2. With no known winner — a cold start — every candidate is probed
 *     CONCURRENTLY and the first success wins. A proxy that accepts TCP and
 *     then never forwards therefore costs nothing instead of one connect
 *     timeout per request; it simply loses the race.
 *  3. If the whole field fails, the error lists every leg. That text is what
 *     the sidebar panel shows.
 *
 * @param config - proxy specifiers, timeouts, TLS policy, and the direct-connection policy.
 * @returns a client with `request`, plus the currently winning transport.
 */
export function createHttpClient(config = {}) {
	const specs = (config.proxies ?? []).map(String).filter((entry) => entry.trim() !== "");
	const parsed = specs.map(parseProxy).filter((entry) => entry !== undefined);
	const unparsable = specs.length - parsed.length;
	// A configured proxy list means the network is fenced; a direct attempt would
	// only add its own timeout to every cold start. Opt in explicitly instead.
	const allowDirect = config.allowDirect ?? parsed.length === 0;
	const candidates = allowDirect ? [...parsed, null] : [...parsed];
	if (candidates.length === 0) throw new Error("no transport configured: add at least one proxy or enable a direct connection");
	const attempts = [];
	const timeoutMs = config.timeoutMs ?? 20000;
	const connectTimeoutMs = config.connectTimeoutMs ?? 10000;
	const insecure = config.insecure === true;
	/** Cached agents, keyed `${label}|${secure}`, so keep-alive actually reuses sockets. */
	const agents = new Map();
	/** Candidates that already failed a probe in this process; skipped until a full-field failure. */
	const coldFailed = new Set();
	let winner;
	/** In-flight cold probe, keyed by request identity so two URLs never share a response. */
	let probing;

	/** Label one candidate for logs and error text. */
	const labelOf = (proxy) => (proxy === null ? "direct" : proxy.raw);

	/** Agent for one candidate, created once and then reused. */
	function agentFor(proxy, secure) {
		const label = labelOf(proxy);
		if (proxy === null) return undefined;
		const key = `${label}|${String(secure)}`;
		let agent = agents.get(key);
		if (agent === undefined) {
			const tunnel = { proxy, connectTimeoutMs, insecure };
			agent = secure ? new TunnelHttpsAgent(tunnel) : new TunnelHttpAgent(tunnel);
			agents.set(key, agent);
		}
		return agent;
	}

	/** One request over one candidate, with timing recorded into `attempts`. */
	async function attempt(proxy, url, options) {
		const label = labelOf(proxy);
		const startedAt = Date.now();
		try {
			const response = await requestOnce(url, {
				method: options.method,
				headers: options.headers,
				body: options.body,
				agent: agentFor(proxy, new URL(url).protocol === "https:"),
				label,
				timeoutMs: options.timeoutMs ?? timeoutMs,
				insecure
			});
			attempts.push(`${label}: ok in ${String(Date.now() - startedAt)}ms`);
			return response;
		} catch (error) {
			attempts.push(`${label}: ${reasonOf(error)} after ${String(Date.now() - startedAt)}ms`);
			throw error;
		}
	}

	/** Race the still-viable candidates; the first success wins, the rest are abandoned. */
	function probe(url, options) {
		const viable = candidates.filter((proxy) => !coldFailed.has(labelOf(proxy)));
		const field = viable.length === 0 ? [...candidates] : viable;
		if (viable.length === 0) coldFailed.clear();
		return new Promise((resolve, reject) => {
			const failures = [];
			let pending = field.length;
			for (const proxy of field) {
				attempt(proxy, url, options).then(
					(response) => {
						winner = proxy;
						resolve(response);
					},
					(error) => {
						coldFailed.add(labelOf(proxy));
						failures.push(`${labelOf(proxy)}: ${reasonOf(error)}`);
						pending -= 1;
						if (pending === 0) reject(new Error(`no transport reached ${new URL(url).host} — ${failures.join("; ")}`));
					}
				);
			}
		});
	}

	/** Winning transport with exactly one retry, then re-probe. */
	async function viaWinner(url, options) {
		try {
			return await attempt(winner, url, options);
		} catch {
			try {
				return await attempt(winner, url, options);
			} catch {
				winner = undefined;
				return undefined;
			}
		}
	}

	return {
		request(url, options = {}) {
			const resolved = {
				method: (options.method ?? "GET").toUpperCase(),
				headers: options.headers ?? {},
				body: options.body,
				timeoutMs: options.timeoutMs
			};
			const key = `${resolved.method} ${url}`;
			return (async () => {
				attempts.length = 0;
				if (winner !== undefined) {
					const response = await viaWinner(url, resolved);
					if (response !== undefined) return response;
				}
				if (probing !== undefined && probing.key === key) return probing.promise;
				const promise = probe(url, resolved);
				probing = { key, promise };
				try {
					return await promise;
				} finally {
					if (probing?.promise === promise) probing = undefined;
				}
			})();
		},
		/** Drop every cached socket and forget the cold-probe verdicts. */
		reset() {
			for (const agent of agents.values()) agent.destroy();
			agents.clear();
			coldFailed.clear();
			winner = undefined;
		},
		get proxy() {
			return winner === undefined ? null : labelOf(winner);
		},
		get attempts() {
			return [...attempts];
		},
		get candidates() {
			return candidates.map(labelOf);
		},
		get unreachable() {
			return [...coldFailed];
		},
		get skippedProxies() {
			return unparsable;
		},
		get directEnabled() {
			return allowDirect;
		}
	};
}
