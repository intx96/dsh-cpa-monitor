/**
 * dsh-cpa-monitor — server half.
 *
 * A Cordis plugin for the dsh web profile. It refreshes a CLIProxyAPI (CPA)
 * account snapshot on a timer and serves it to the browser half over two
 * loopback-only exact routes:
 *
 *   GET       /api/cpa-monitor/snapshot   → the cached snapshot (`?refresh=1` forces)
 *   GET|POST  /api/cpa-monitor/refresh    → force a refresh (needs the action header)
 *
 * Configuration has three layers, composed by the host:
 *
 *   schema defaults  →  composition entry (this package's cordis.patch.yml)
 *                    →  user layer
 *
 * The user layer is the fourth and last thing the two host generations disagree
 * about. On DSH ≤ 0.1 it is a namespace section of `$DSH_HOME/settings.yaml`,
 * registered by this module and edited by the Settings → Plugins card. On
 * DSH ≥ 0.2 the configuration surface is derived from this module's exported
 * `Config` (see {@link Config}) and the edit lands in the profile's own
 * configuration document — which reloads this entry, so a saved change still
 * rebuilds the transport and restarts the poller without a restart.
 *
 * The composition entry alone is always enough: if a deployment composes no
 * configuration host, or the schema package is missing, the monitor still runs
 * from the entry config and only the configuration form is absent.
 *
 * @module dsh-cpa-monitor
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHttpClient, parseProxy } from "./net.js";
import { CpaInputError, collectSnapshot, listErrorLogs, readErrorLog, setAccountDisabled, setAccountFields } from "./cpa.js";
import { loadSchemastery } from "./schema.js";

/** Stable Cordis plugin name; also the settings namespace and the card key. */
export const name = "cpa-monitor";

/** Services required before this plugin activates; `settings` is joined optionally below. */
export const inject = ["webServer"];

/** Settings namespace carrying the user-overridable configuration. */
export const SETTINGS_NAMESPACE = "cpa-monitor";

/** Snapshot route, polled by the sidebar panel. */
export const SNAPSHOT_PATH = "/api/cpa-monitor/snapshot";

/** Explicit refresh route. */
export const REFRESH_PATH = "/api/cpa-monitor/refresh";

/** Failed-request diagnostics: `GET` lists, `GET ?file=` reads one. */
export const DIAGNOSTICS_PATH = "/api/cpa-monitor/diagnostics";

/** Credential management: `POST` enables/disables or edits one account. */
export const ACCOUNT_PATH = "/api/cpa-monitor/account";

/**
 * Features this server half serves.
 *
 * The browser half is hot-reloaded while this half only changes on a restart, so
 * a client running ahead of its server is a normal state — not an error. The
 * payload advertises what is actually available, and the panel hides what is not
 * instead of showing controls that cannot work. Absence of the whole list means a
 * server older than this contract.
 */
export const CAPABILITIES = ["account", "diagnostics", "cpa"];

/** Header a refresh request must carry (blocks cross-origin side effects). */
export const ACTION_HEADER = "x-dsh-cpa-monitor-action";

/** Environment fallback for the management key, so it need not be stored at all. */
export const KEY_ENV = "DSH_CPA_MANAGEMENT_KEY";

/** Composition-layer defaults; also what a field reverts to when cleared in the UI. */
export const ENTRY_DEFAULTS = {
	baseURL: "https://cpa.example.com:8317",
	managementKey: "",
	proxies: ["http://127.0.0.1:1081", "http://127.0.0.1:1080"],
	allowDirect: false,
	providerFilter: "codex",
	// Which figure the sidebar badge reports: the most critical account, or the
	// per-window sum across accounts.
	badgeMode: "lowest",
	includeDisabled: true,
	refreshIntervalMs: 300_000,
	timeoutMs: 20_000,
	connectTimeoutMs: 10_000,
	timeZone: "Asia/Shanghai",
	insecure: false
};

/** The badge reporting modes; the settings schema and the normalizer both enforce these. */
export const BADGE_MODES = ["lowest", "total"];

/** Wire schema bounds, shared by the settings schema and the composition normalizer. */
const LIMITS = {
	refreshIntervalMs: 5_000,
	timeoutMs: 1_000,
	connectTimeoutMs: 500
};

/**
 * Normalize a composition entry config.
 *
 * Dependency-free on purpose: this runs before the schema package is loaded, and
 * it is also the `Config` export the Cordis loader validates the entry with.
 *
 * @param raw - the patch entry's `config` object.
 * @returns the composition base layer.
 * @throws {Error} on any malformed field.
 */
export function normalizeEntryConfig(raw = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plugin config must be an object");
	const text = (value, field, fallback) => {
		if (value === undefined || value === null || value === "") return fallback;
		if (typeof value !== "string") throw new Error(`${field} must be a string`);
		return value.trim();
	};
	const flag = (value, field, fallback) => {
		if (value === undefined || value === null) return fallback;
		if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
		return value;
	};
	const count = (value, field, fallback, min) => {
		if (value === undefined || value === null) return fallback;
		const number = Number(value);
		if (!Number.isFinite(number) || number < min) throw new Error(`${field} must be a number >= ${String(min)}`);
		return number;
	};
	const proxies = raw.proxies;
	if (proxies !== undefined && (!Array.isArray(proxies) || proxies.some((entry) => typeof entry !== "string"))) {
		throw new Error("proxies must be an array of strings");
	}
	const baseURL = text(raw.baseURL, "baseURL", ENTRY_DEFAULTS.baseURL);
	if (!/^https?:\/\//i.test(baseURL)) throw new Error("baseURL must start with http:// or https://");
	const badgeMode = text(raw.badgeMode, "badgeMode", ENTRY_DEFAULTS.badgeMode);
	if (!BADGE_MODES.includes(badgeMode)) throw new Error(`badgeMode must be one of ${BADGE_MODES.join(" | ")}`);
	return {
		baseURL,
		managementKey: text(raw.managementKey, "managementKey", ENTRY_DEFAULTS.managementKey),
		proxies: proxies === undefined ? [...ENTRY_DEFAULTS.proxies] : proxies.map((entry) => entry.trim()).filter((entry) => entry !== ""),
		allowDirect: flag(raw.allowDirect, "allowDirect", ENTRY_DEFAULTS.allowDirect),
		providerFilter: text(raw.providerFilter, "providerFilter", ENTRY_DEFAULTS.providerFilter),
		badgeMode,
		includeDisabled: flag(raw.includeDisabled, "includeDisabled", ENTRY_DEFAULTS.includeDisabled),
		refreshIntervalMs: count(raw.refreshIntervalMs, "refreshIntervalMs", ENTRY_DEFAULTS.refreshIntervalMs, LIMITS.refreshIntervalMs),
		timeoutMs: count(raw.timeoutMs, "timeoutMs", ENTRY_DEFAULTS.timeoutMs, LIMITS.timeoutMs),
		connectTimeoutMs: count(raw.connectTimeoutMs, "connectTimeoutMs", ENTRY_DEFAULTS.connectTimeoutMs, LIMITS.connectTimeoutMs),
		timeZone: text(raw.timeZone, "timeZone", ENTRY_DEFAULTS.timeZone),
		insecure: flag(raw.insecure, "insecure", ENTRY_DEFAULTS.insecure)
	};
}

/** The write half a live-editable field's cell exposes; see {@link plainEntryConfig}. */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * Read one resolved config field as a plain value.
 *
 * A field the host marked live-editable (see {@link createSettingsSchema}) does
 * not arrive as a value but as a writable CELL — `{ get(), [VOLATILE_WRITE](next) }`
 * — and the cell stays live: the host writes a new value into it and emits
 * `loader/volatile-update` instead of re-applying the entry, so `get()` is the
 * only correct read for both the initial and every later value. Plain fields
 * pass through untouched.
 *
 * @param value - one resolved field, cell or plain.
 * @returns the field's value.
 */
function fieldValue(value) {
	return value !== null && typeof value === "object" && typeof value.get === "function" && VOLATILE_WRITE in value ? value.get() : value;
}

/**
 * Project a resolved entry config into plain values.
 *
 * Everything downstream (normalization, the cross-field rules, the runtime
 * config, the environment-key fallback) works on plain values, so cells are
 * unwrapped once here rather than at each use.
 *
 * @param raw - the entry config handed to `apply`, or any resolved section.
 * @returns the same object with every field's value.
 */
export function plainEntryConfig(raw) {
	if (raw === null || typeof raw !== "object") return raw;
	return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, fieldValue(value)]));
}

/**
 * Entry-config schema in the dependency-free Standard Schema shape.
 *
 * This validates a composition entry but carries no form, so it is only the
 * fallback for a checkout where schemastery cannot be resolved at all.
 */
const STANDARD_CONFIG = {
	"~standard": {
		version: 1,
		vendor: "dsh-cpa-monitor",
		validate(value) {
			try {
				return { value: normalizeEntryConfig(plainEntryConfig(value ?? {})) };
			} catch (error) {
				return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
			}
		}
	}
};

/** Schemastery handle behind {@link Config}, or undefined when none resolved. */
let schemaHandle;

/** Why {@link Config} fell back to the Standard Schema object, if it did. */
let schemaError;

/**
 * The entry-config schema this module exports.
 *
 * Both host generations read it, for different purposes:
 *
 * - DSH ≤ 0.1 validates the Loader row with it, and takes the settings namespace
 *   schema from the `settings.register()` call in {@link apply}.
 * - DSH ≥ 0.2 derives the ENTIRE configuration surface from it. `dsh-settings`
 *   projects an editable form out of `"toJSON" in Config`, keys that form by the
 *   row id, and matches the sections of a migrated `settings.yaml` against those
 *   same rows. A plain Standard Schema object can satisfy none of that: the row
 *   then has no form, so the Plugins page would offer a configure control that
 *   opens nothing, and a saved `settings.yaml` section would not be importable.
 *
 * Schemastery satisfies both, so it is preferred whenever it loads. The
 * fallback keeps the monitor booting from the composition entry alone on a
 * checkout that never ran `npm install`; only the configuration UI is lost.
 *
 * Resolved SYNCHRONOUSLY at module scope: a host may read this export while it
 * resolves the entry, and a module whose exports only exist after top-level
 * `await` cannot be loaded that way at all (see {@link loadSchemastery}).
 */
export const Config = (() => {
	try {
		schemaHandle = loadSchemastery();
		return createSettingsSchema(schemaHandle);
	} catch (error) {
		schemaError = error instanceof Error ? error.message : String(error);
		return STANDARD_CONFIG;
	}
})();

/**
 * Build the settings schema for one schemastery instance.
 *
 * No field is `required`: the user layer may legitimately hold an empty
 * `managementKey` (the runtime then reads {@link KEY_ENV}), and refusing a
 * stored section at registration would leave a user no way to repair it from
 * the UI that the refusal also hides.
 *
 * EVERY field is marked volatile, which is the host's word for "editable
 * without a reload". DSH ≥ 0.2 builds each configuration form from this schema
 * and keeps ONLY volatile leaves — `dsh-settings`' `volatileForm()` drops every
 * other field and gives up entirely on an entry whose fields all drop — and its
 * `write()` refuses any path not under a volatile node. A schema that marks
 * nothing therefore has NO form, however well it validates: the row gets a
 * configure control that opens an empty page. Official bundles do the same for
 * their own entries (`@deepseek-ai/dsh-subagent`'s `static Config` marks every
 * field `.volatile()`).
 *
 * @param z - the schemastery default export.
 * @returns the namespace schema.
 */
export function createSettingsSchema(z) {
	/**
	 * Mark one field live-editable.
	 *
	 * The harness ships a patched schemastery (3.18.4) whose `.volatile()` is
	 * exactly `extra("volatile", true)`; the published 3.18.2 has no such helper.
	 * Spelling the meta through `extra` works against either build, so the form
	 * does not depend on which copy of the package resolved.
	 */
	const live = (schema) => schema.extra("volatile", true);
	return z.object({
		baseURL: live(z.string().default(ENTRY_DEFAULTS.baseURL).description("CLIProxyAPI 管理口地址")),
		managementKey: live(z.string().role("secret").default(ENTRY_DEFAULTS.managementKey).description(`管理密钥；留空则回退读环境变量 ${KEY_ENV}`)),
		proxies: live(z.array(z.string()).default([...ENTRY_DEFAULTS.proxies]).description("出网代理候选，按顺序尝试；支持 http:// / https:// / socks5://，可为空")),
		allowDirect: live(z.boolean().default(ENTRY_DEFAULTS.allowDirect).description("所有代理都失败后是否再试直连（代理列表为空时自动直连）")),
		providerFilter: live(z.string().default(ENTRY_DEFAULTS.providerFilter).description("只监控该 provider，留空表示全部")),
		badgeMode: live(
			z
				.union([z.const("lowest"), z.const("total")])
				.default(ENTRY_DEFAULTS.badgeMode)
				.description("侧栏徽标口径：lowest = 显示最紧张那个账号的余量；total = 各账号按窗口累加")
		),
		includeDisabled: live(z.boolean().default(ENTRY_DEFAULTS.includeDisabled).description("是否也列出 CPA 里已禁用的账号")),
		refreshIntervalMs: live(z.natural().min(LIMITS.refreshIntervalMs).default(ENTRY_DEFAULTS.refreshIntervalMs).description("后台轮询周期（毫秒，最小 5000）")),
		timeoutMs: live(z.natural().min(LIMITS.timeoutMs).default(ENTRY_DEFAULTS.timeoutMs).description("单个请求端到端超时（毫秒）")),
		connectTimeoutMs: live(
			z
				.natural()
				.min(LIMITS.connectTimeoutMs)
				.default(ENTRY_DEFAULTS.connectTimeoutMs)
				.description("单条传输腿的握手/TLS 超时（毫秒），不能大于请求超时")
		),
		timeZone: live(z.string().default(ENTRY_DEFAULTS.timeZone).description("重置时间显示时区，例如 Asia/Shanghai")),
		insecure: live(z.boolean().default(ENTRY_DEFAULTS.insecure).description("跳过 TLS 证书校验（仅用于自签名证书的 CPA）"))
	});
}

/**
 * Cross-field rules no schema can express, enforced on every write and on the
 * stored section at registration.
 * @param value - a schema-resolved section.
 * @throws {Error} with an actionable message.
 */
export function validateResolved(value) {
	const config = plainEntryConfig(value);
	if (!/^https?:\/\//i.test(config.baseURL)) throw new Error("baseURL 必须以 http:// 或 https:// 开头");
	const bad = config.proxies.filter((entry) => parseProxy(entry) === undefined);
	if (bad.length > 0) throw new Error(`无法解析的代理地址：${bad.join("、")}（支持 http://、https://、socks5://）`);
	if (config.connectTimeoutMs > config.timeoutMs) {
		throw new Error(`connectTimeoutMs (${String(config.connectTimeoutMs)}) 不能大于 timeoutMs (${String(config.timeoutMs)})`);
	}
	if (config.timeZone !== "") {
		try {
			new Intl.DateTimeFormat("zh-CN", { timeZone: config.timeZone });
		} catch {
			throw new Error(`无法识别的时区：${config.timeZone}`);
		}
	}
}

/**
 * Resolve a settings value into the runtime configuration.
 * @param value - a schema-resolved section, whose live-editable fields may arrive as cells.
 * @returns the runtime config (environment key fallback and direct rule applied).
 */
export function resolveRuntimeConfig(value) {
	const config = plainEntryConfig(value);
	return {
		...config,
		managementKey: config.managementKey === "" ? (process.env[KEY_ENV] ?? "") : config.managementKey,
		// With no proxy configured, a direct connection is the only transport there
		// is, so it is implicit rather than something the user must also tick.
		allowDirect: config.allowDirect || config.proxies.length === 0
	};
}

/**
 * The configuration as exposed to the browser: everything except the secret.
 * @param config - the runtime config.
 * @returns a redacted view.
 */
export function publicConfig(config) {
	return {
		baseURL: config.baseURL,
		proxies: [...config.proxies],
		allowDirect: config.allowDirect,
		providerFilter: config.providerFilter,
		badgeMode: config.badgeMode,
		includeDisabled: config.includeDisabled,
		refreshIntervalMs: config.refreshIntervalMs,
		timeoutMs: config.timeoutMs,
		connectTimeoutMs: config.connectTimeoutMs,
		timeZone: config.timeZone,
		insecure: config.insecure,
		managementKeyConfigured: config.managementKey !== "",
		managementKeyFromEnv: config.managementKey !== "" && process.env[KEY_ENV] === config.managementKey
	};
}

/**
 * What THIS running process actually holds, as opposed to what is on disk.
 *
 * A profile plugin is only re-imported when its Loader entry is re-applied, so a
 * host that keeps running after the package directory changed keeps serving the
 * old code — and the visible symptom is nothing but a missing configuration
 * form, which is indistinguishable from a schema that failed to resolve.
 * Reporting both facts makes that a thing to read rather than to reproduce.
 *
 * @returns the loaded module's mtime plus the schema state behind {@link Config}.
 */
export function serverSelfReport() {
	const dict = Config?.dict ?? {};
	const names = Object.keys(dict);
	const report = {
		schemastery: schemaHandle !== undefined,
		schemaError: schemaError ?? null,
		configForm: typeof Config?.toJSON === "function",
		// The form keeps ONLY volatile fields, so this count — not `configForm` —
		// is what predicts whether a configuration page has anything to render.
		fields: names.length,
		volatileFields: names.filter((name) => dict[name]?.meta?.volatile === true).length,
		mtimeMs: null
	};
	try {
		report.mtimeMs = statSync(fileURLToPath(import.meta.url)).mtimeMs;
	} catch {
		// A host that cannot stat the module still gets the schema facts.
	}
	return report;
}

/**
 * Build the transport used by the poller.
 * @param config - a runtime config.
 * @returns the HTTP client.
 */
export function createClient(config) {
	return createHttpClient({
		proxies: config.proxies,
		allowDirect: config.allowDirect,
		timeoutMs: config.timeoutMs,
		connectTimeoutMs: config.connectTimeoutMs,
		insecure: config.insecure
	});
}

/** True when the socket peer is the local machine. */
function isLoopback(req) {
	const address = req.socket?.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Read a request body as text, with a hard cap so a bad client cannot balloon it. */
function readBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("request body too large"));
				req.destroy?.();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Write a JSON response. */
function sendJson(res, status, payload) {
	const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": body.length });
	res.end(body);
}

/**
 * The swappable half of the plugin: transport, poller, cache, and route handler.
 *
 * `activate` is the only mutation point, so a live settings change replaces the
 * configuration atomically. Each activation bumps a generation, which fences an
 * in-flight observation started under the previous configuration out of the
 * cache — otherwise a slow read against the old CPA could land after a new one
 * was already configured.
 *
 * @param ctx - plugin context carrying `logger`.
 * @param deps - overridable seams; `createClient` lets tests drive the whole
 *   management surface from canned CPA responses instead of a live host.
 * @returns the runtime handle used by `apply`.
 */
export function createRuntime(ctx, deps = {}) {
	const logger = ctx.logger;
	const makeClient = deps.createClient ?? createClient;
	let config;
	let client;
	let timer;
	let generation = 0;
	let inFlightToken;
	let inFlightPromise;
	let snapshot;
	let lastError;
	let lastSuccessAt;

	/**
	 * Run one observation for a fixed generation.
	 * @param token - the generation token this observation belongs to.
	 * @param activeClient - the client captured at call time.
	 * @param activeConfig - the config captured at call time.
	 * @returns the snapshot current after this observation.
	 */
	async function observe(token, activeClient, activeConfig) {
		try {
			if (activeConfig.managementKey === "") {
				throw new Error(`未配置管理密钥 managementKey（设置 → 插件 → ${SETTINGS_NAMESPACE}，或设环境变量 ${KEY_ENV}）`);
			}
			const next = await collectSnapshot(activeClient, activeConfig);
			if (token.generation !== generation) return snapshot;
			snapshot = next;
			lastSuccessAt = next.fetchedAt;
			lastError = undefined;
			logger?.info?.(
				"cpa-monitor: %d account(s) via %s in %dms (%d need attention)",
				next.counts.total,
				next.proxy,
				next.durationMs,
				next.attention
			);
			return snapshot;
		} catch (error) {
			if (token.generation === generation) {
				lastError = error instanceof Error ? error.message : String(error);
				logger?.warn?.("cpa-monitor: refresh failed: %s", lastError);
			}
			return snapshot;
		}
	}

	/**
	 * Refresh the snapshot, de-duplicating concurrent callers.
	 * @param options - `force` abandons an observation already in flight, so a
	 *   post-write read can never be answered by a pre-write one.
	 * @returns the current snapshot, or undefined when nothing has ever succeeded.
	 */
	function refresh(options = {}) {
		if (options.force === true) {
			// The generation fence is what makes the abandoned observation drop its
			// result instead of overwriting the fresher one.
			generation += 1;
			inFlightToken = undefined;
			inFlightPromise = undefined;
		}
		if (inFlightPromise !== undefined) return inFlightPromise;
		const token = { generation };
		inFlightToken = token;
		const promise = observe(token, client, config).finally(() => {
			if (inFlightToken === token) {
				inFlightToken = undefined;
				inFlightPromise = undefined;
			}
		});
		inFlightPromise = promise;
		return promise;
	}

	/** The cache is stale once its age passes the poll period. */
	function isStale() {
		if (snapshot === undefined) return true;
		return Date.now() - snapshot.fetchedAt >= config.refreshIntervalMs;
	}

	/** Snapshot payload shared by both routes. */
	function payload() {
		const age = lastSuccessAt === undefined ? null : Date.now() - lastSuccessAt;
		return {
			ok: snapshot !== undefined,
			snapshot,
			error: lastError,
			ageMs: age,
			intervalMs: config?.refreshIntervalMs ?? null,
			config: config === undefined ? null : publicConfig(config),
			capabilities: [...CAPABILITIES],
			server: serverSelfReport()
		};
	}

	/**
	 * Route handler for both endpoints.
	 * @param req - the request.
	 * @param res - the response.
	 */
	async function handle(req, res) {
		try {
			if (!isLoopback(req)) {
				sendJson(res, 403, { ok: false, error: "cpa-status endpoints are loopback-only" });
				return;
			}
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const isRefreshRoute = url.pathname === REFRESH_PATH;
			const forced = isRefreshRoute || url.searchParams.get("refresh") === "1";
			if (forced && req.headers[ACTION_HEADER] === undefined) {
				sendJson(res, 400, { ok: false, error: `refresh requests must carry the ${ACTION_HEADER} header` });
				return;
			}
			if (forced || isStale()) await refresh();
			sendJson(res, 200, payload());
		} catch (error) {
			sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Resolve a browser-supplied `authIndex` to the credential file name every
	 * management write addresses — the browser never names a file itself.
	 * @param authIndex - the credential index from the snapshot.
	 * @returns the credential file name.
	 * @throws {Error} when the snapshot does not know that credential.
	 */
	function credentialName(authIndex) {
		const account = (snapshot?.accounts ?? []).find((entry) => entry.authIndex === authIndex);
		if (account === undefined) throw new Error(`unknown authIndex ${authIndex}; refresh the snapshot first`);
		if (account.name === "") throw new Error(`authIndex ${authIndex} has no credential file name`);
		return account.name;
	}

	/**
	 * Route handler for credential writes. POST only, and only with the action
	 * header: this changes what the proxy will serve next.
	 * @param req - the request.
	 * @param res - the response.
	 */
	async function handleAccount(req, res) {
		try {
			if (!isLoopback(req)) {
				sendJson(res, 403, { ok: false, error: "cpa-status endpoints are loopback-only" });
				return;
			}
			if ((req.method ?? "GET").toUpperCase() !== "POST") {
				sendJson(res, 405, { ok: false, error: "credential writes are POST-only" });
				return;
			}
			if (req.headers[ACTION_HEADER] === undefined) {
				sendJson(res, 400, { ok: false, error: `credential writes must carry the ${ACTION_HEADER} header` });
				return;
			}
			const body = JSON.parse(await readBody(req));
			if (snapshot === undefined) await refresh();
			const name = credentialName(String(body.authIndex ?? ""));
			if (body.action === "status") {
				if (typeof body.disabled !== "boolean") throw new Error("`disabled` must be a boolean");
				await setAccountDisabled(client, config, name, body.disabled);
			} else if (body.action === "fields") {
				const patch = {};
				if (body.note !== undefined) {
					if (typeof body.note !== "string") throw new Error("`note` must be a string");
					patch.note = body.note;
				}
				if (body.priority !== undefined) {
					if (!Number.isFinite(Number(body.priority))) throw new Error("`priority` must be a number");
					patch.priority = Number(body.priority);
				}
				await setAccountFields(client, config, name, patch);
			} else {
				throw new Error(`unknown action "${String(body.action)}"`);
			}
			logger?.info?.("cpa-monitor: wrote %s on %s", String(body.action), name);
			// Fold the write back into the cache so the caller sees its result.
			await refresh({ force: true });
			sendJson(res, 200, payload());
		} catch (error) {
			sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Route handler for failed-request diagnostics. GET only: listing is one
	 * upstream call, and `?file=` reads one log whose name is validated against
	 * that listing before anything is fetched.
	 * @param req - the request.
	 * @param res - the response.
	 */
	async function handleDiagnostics(req, res) {
		try {
			if (!isLoopback(req)) {
				sendJson(res, 403, { ok: false, error: "cpa-status endpoints are loopback-only" });
				return;
			}
			if ((req.method ?? "GET").toUpperCase() !== "GET") {
				sendJson(res, 405, { ok: false, error: "diagnostics are read-only" });
				return;
			}
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const file = url.searchParams.get("file");
			if (file === null || file === "") {
				const listed = await listErrorLogs(client, config);
				sendJson(res, 200, { ok: true, ...listed, intervalMs: config.refreshIntervalMs });
				return;
			}
			sendJson(res, 200, { ok: true, log: await readErrorLog(client, config, file) });
		} catch (error) {
			// A bad name is the caller's mistake; anything else is CPA's.
			sendJson(res, error instanceof CpaInputError ? 400 : 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	return {
		/**
		 * Adopt one configuration: rebuild the transport, restart the poller, and
		 * observe immediately. Any in-flight observation is fenced out.
		 * @param value - a schema-resolved or composition-normalized section.
		 */
		activate(value) {
			generation += 1;
			inFlightToken = undefined;
			inFlightPromise = undefined;
			config = resolveRuntimeConfig(value);
			client = makeClient(config);
			if (timer !== undefined) clearInterval(timer);
			timer = setInterval(() => {
				void refresh();
			}, config.refreshIntervalMs);
			// Never hold a shutting-down host open on the poller's account.
			timer.unref?.();
			logger?.info?.(
				"cpa-monitor: monitoring %s through %s every %ds (zone %s)",
				config.baseURL,
				config.proxies.length === 0 ? "a direct connection" : config.proxies.join(" → "),
				Math.round(config.refreshIntervalMs / 1000),
				config.timeZone
			);
			void refresh();
		},
		/** Stop the poller. */
		stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		},
		handle,
		handleAccount,
		handleDiagnostics,
		refresh,
		payload,
		/** @returns the active runtime config. */
		current() {
			return config;
		}
	};
}

/**
 * Plugin body: build the runtime, register the routes, and bind the settings
 * namespace when the deployment composes one.
 * @param ctx - plugin context carrying `webServer`, `logger`, and optionally `settings`.
 * @param rawConfig - the patch entry's `config` object.
 */
export async function apply(ctx, rawConfig = {}, deps = {}) {
	const base = normalizeEntryConfig(plainEntryConfig(rawConfig));
	const runtime = createRuntime(ctx, deps);
	// Composition config first, so the monitor runs even with no settings service.
	runtime.activate(base);

	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: SNAPSHOT_PATH, handler: runtime.handle }),
		"cpa-monitor: snapshot route"
	);
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: REFRESH_PATH, handler: runtime.handle }),
		"cpa-monitor: refresh route"
	);
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: ACCOUNT_PATH, handler: runtime.handleAccount }),
		"cpa-monitor: credential write route"
	);
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: DIAGNOSTICS_PATH, handler: runtime.handleDiagnostics }),
		"cpa-monitor: diagnostics route"
	);
	ctx.effect(() => () => runtime.stop(), "cpa-monitor: refresh timer");

	// A live-editable field is not re-applied when the host writes it: the value
	// goes into the field's cell and the Loader announces the change instead (see
	// {@link plainEntryConfig}). Re-reading the same `rawConfig` object therefore
	// sees the new value, and this is what makes a saved edit take effect without
	// a restart on DSH ≥ 0.2. The 0.1 path never emits this event; it watches the
	// namespace scope below instead.
	ctx.on("loader/volatile-update", () => {
		try {
			runtime.activate(resolveRuntimeConfig(rawConfig));
		} catch (error) {
			ctx.logger?.warn?.("cpa-monitor: rejected a live configuration change — %s", error instanceof Error ? error.message : String(error));
		}
	});

	// The configuration form is an upgrade, never a boot dependency: the monitor
	// already runs from the composition entry above, so a checkout without
	// schemastery simply loses the UI.
	if (schemaHandle === undefined) {
		ctx.logger?.warn?.("cpa-monitor: configuration UI unavailable — %s", schemaError ?? "schemastery is not resolvable");
		return;
	}
	ctx.inject(["settings"], (sctx) => {
		// DSH ≥ 0.2 replaced this API: its `settings` service derives every form
		// from the row's exported {@link Config} and writes through the profile's
		// config editor, which reloads this entry — so there is no namespace to
		// register and nothing to watch. DSH ≤ 0.1 still needs the registration.
		if (typeof sctx.settings?.register !== "function") {
			sctx.logger?.info?.("cpa-monitor: host derives the configuration form from the exported Config; no namespace registration needed");
			return;
		}
		const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, {
			base,
			applies: "live",
			validate: validateResolved
		});
		runtime.activate(scope.get());
		sctx.effect(() => scope.watch((next) => runtime.activate(next)), "cpa-monitor: live settings");
		sctx.logger?.info?.("cpa-monitor: settings namespace %s registered (applies live)", SETTINGS_NAMESPACE);
	});
}
