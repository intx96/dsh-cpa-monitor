/**
 * dsh-cpa-monitor — CLIProxyAPI (CPA) domain logic.
 *
 * Ports the reference Python collector (`update-plus.py`) and extends it: the
 * account list is discovered from the management API instead of being
 * hardcoded, and each account also carries its CPA health (status, disabled,
 * success/failed counters, recent request buckets).
 *
 * CPA management surface used here:
 *   GET  /v0/management/auth-files   → every credential, with `auth_index`,
 *                                      `id_token.chatgpt_account_id`, `status`
 *   POST /v0/management/api-call     → proxied upstream call; `$TOKEN$` in a
 *                                      header is replaced with that credential's
 *                                      access token
 *
 * @module dsh-cpa-monitor/cpa
 */

/** Upstream usage endpoint, addressed through `api-call`. */
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Known rate-limit window durations (seconds) and their labels, ±10%. */
const KNOWN_WINDOWS = [
	[5 * 3600, "5h"],
	[7 * 86_400, "7d"],
	[30 * 86_400, "30d"]
];

/**
 * A rejection caused by the caller's input rather than by CPA — a bad log name,
 * a field write with nothing to write. Route handlers map it to 400 and treat
 * everything else as an upstream failure.
 */
export class CpaInputError extends Error {}

/** The one shape the panel renders when a value is missing. */
export const EMPTY_TEXT = "—";

/**
 * Parse a JSON response body, tolerating the double-encoded form `api-call` returns.
 * @param body - string, object, or undefined.
 * @returns the parsed object, or undefined.
 */
function asJson(body) {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "object") return body;
	if (typeof body !== "string") return undefined;
	const text = body.trim();
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Short, single-line preview of an upstream body for error messages. */
function preview(body, limit = 160) {
	const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Label a rate-limit window by its duration.
 * @param seconds - `limit_window_seconds`.
 * @returns `5h` / `7d` / `30d`, or a computed `Nh` / `Nd`.
 */
export function windowLabel(seconds) {
	const value = Number(seconds);
	if (!Number.isFinite(value) || value <= 0) return "?";
	for (const [known, label] of KNOWN_WINDOWS) {
		if (Math.abs(value - known) / known <= 0.1) return label;
	}
	return value < 86_400 ? `${String(Math.round(value / 3600))}h` : `${String(Math.round(value / 86_400))}d`;
}

/**
 * Format a Unix timestamp in the configured zone as `MM/DD HH:MM`.
 * @param ts - Unix seconds.
 * @param timeZone - IANA zone name.
 * @returns the formatted text, or the empty placeholder.
 */
export function formatResetAt(ts, timeZone) {
	const seconds = Number(ts);
	if (!Number.isFinite(seconds) || seconds <= 0) return EMPTY_TEXT;
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone,
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false
		}).format(new Date(seconds * 1000));
	} catch {
		return new Date(seconds * 1000).toISOString().slice(5, 16).replace("T", " ");
	}
}

/**
 * Normalize one raw window into the panel's model.
 * @param window - a `primary_window` / `secondary_window` object.
 * @param timeZone - IANA zone name for the reset text.
 * @returns the window model, or null when the input is unusable.
 */
export function parseWindow(window, timeZone) {
	if (window === null || typeof window !== "object") return null;
	const used = Number(window.used_percent);
	const resetAt = Number(window.reset_at);
	const resetIn = Number(window.reset_after_seconds);
	return {
		label: windowLabel(window.limit_window_seconds),
		windowSeconds: Number(window.limit_window_seconds) || null,
		usedPercent: Number.isFinite(used) ? used : null,
		remaining: Number.isFinite(used) ? Math.round((100 - used) * 10) / 10 : null,
		resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : null,
		resetText: formatResetAt(resetAt, timeZone),
		resetInSeconds: Number.isFinite(resetIn) && resetIn >= 0 ? resetIn : null
	};
}

/**
 * Split a `rate_limit` into its short (5h) and long (7d / 30d) windows.
 *
 * Faithful port of the Python `pick_windows`: a free account that only reports
 * a 30-day window must land in the long slot, never in `primary`.
 *
 * @param rateLimit - the upstream `rate_limit` object.
 * @param timeZone - IANA zone name for reset text.
 * @returns the short and long window models (either may be null).
 */
export function pickWindows(rateLimit, timeZone) {
	const source = rateLimit !== null && typeof rateLimit === "object" ? rateLimit : {};
	const candidates = [source.primary_window, source.secondary_window].filter(
		(window) => window !== null && window !== undefined && typeof window === "object"
	);
	let short;
	let long;
	for (const window of candidates) {
		const label = windowLabel(window.limit_window_seconds);
		if (label === "5h" && short === undefined) short = window;
		else if ((label === "7d" || label === "30d") && long === undefined) long = window;
	}
	if (short === undefined && long === undefined) {
		return [parseWindow(source.primary_window, timeZone), parseWindow(source.secondary_window, timeZone)];
	}
	if (short === undefined) short = candidates.find((window) => window !== long);
	if (long === undefined) long = candidates.find((window) => window !== short);
	return [parseWindow(short, timeZone), parseWindow(long, timeZone)];
}

/**
 * Parse an `api-call` envelope into the panel's usage model.
 * @param envelope - the management API response.
 * @param timeZone - IANA zone name for reset text.
 * @returns the usage model; `error` is set when the upstream call failed.
 */
export function parseUsage(envelope, timeZone) {
	const status = Number(envelope?.status_code);
	if (status !== 200) {
		return {
			ok: false,
			error: `upstream HTTP ${Number.isFinite(status) ? String(status) : "???"}${
				preview(envelope?.body) === "" ? "" : `: ${preview(envelope?.body)}`
			}`,
			plan: EMPTY_TEXT,
			windows: [],
			short: null,
			long: null
		};
	}
	const body = asJson(envelope?.body);
	if (body === undefined) {
		return { ok: false, error: "upstream returned a non-JSON body", plan: EMPTY_TEXT, windows: [], short: null, long: null };
	}
	const [short, long] = pickWindows(body.rate_limit, timeZone);
	const windows = [short, long].filter((window) => window !== null && window !== undefined);
	const credits = body.credits ?? null;
	return {
		ok: true,
		error: null,
		plan: body.plan_type ?? EMPTY_TEXT,
		email: body.email ?? null,
		windows,
		short: short ?? null,
		long: long ?? null,
		limitReached: body.rate_limit?.limit_reached === true,
		allowed: body.rate_limit?.allowed !== false,
		rateLimitReachedType: body.rate_limit_reached_type ?? null,
		spendControlReached: body.spend_control?.reached === true,
		credits: credits === null
			? null
			: {
				hasCredits: credits.has_credits === true,
				unlimited: credits.unlimited === true,
				balance: credits.balance ?? null,
				overageLimitReached: credits.overage_limit_reached === true
			},
		resetCredits: Number(body.rate_limit_reset_credits?.available_count ?? 0) || 0
	};
}

/**
 * Render the py collector's compact summary string, e.g. `94%/80%-08/26 14:30`.
 * @param usage - a parsed usage model.
 * @returns the summary text.
 */
export function summaryValue(usage) {
	const percent = (window) => (window?.remaining === null || window?.remaining === undefined ? EMPTY_TEXT : `${String(window.remaining)}%`);
	const reset = usage.long?.resetText ?? usage.short?.resetText ?? EMPTY_TEXT;
	return `${percent(usage.short)}/${percent(usage.long)}-${reset}`;
}

/**
 * Build the `Authorization` header value for the management API.
 * @param managementKey - the configured management key.
 * @returns header value.
 */
function bearer(managementKey) {
	return /^bearer\s/i.test(managementKey) ? managementKey : `Bearer ${managementKey}`;
}

/**
 * List the CPA credentials we monitor.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL, key, and provider filter.
 * @returns the normalized credential records plus the CPA build the response
 * describes (`x-cpa-version` and friends ride every management response).
 * @throws when the management API cannot be reached or rejects the key.
 */
export async function listAccounts(client, config) {
	const url = `${config.baseURL.replace(/\/+$/, "")}/v0/management/auth-files`;
	const response = await client.request(url, {
		method: "GET",
		headers: { authorization: bearer(config.managementKey), accept: "application/json" }
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error(`management key rejected (HTTP ${String(response.status)})`);
	}
	if (response.status !== 200) {
		throw new Error(`auth-files returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	}
	const payload = asJson(response.body);
	const files = Array.isArray(payload?.files) ? payload.files : undefined;
	if (files === undefined) throw new Error("auth-files response has no `files` array");
	const wanted = String(config.providerFilter ?? "").trim().toLowerCase();
	const accounts = files
		.map((file) => {
			const provider = String(file.provider ?? file.type ?? "").trim();
			const claims = file.id_token ?? {};
			return {
				authIndex: String(file.auth_index ?? "").trim(),
				// `name` is the credential's file name, and it is what every
				// management write addresses (`PATCH /auth-files/status|fields`).
				name: String(file.name ?? file.id ?? "").trim(),
				email: String(file.email ?? file.account ?? "").trim(),
				provider,
				accountId: String(claims.chatgpt_account_id ?? "").trim(),
				claimPlan: claims.plan_type ? String(claims.plan_type) : null,
				status: String(file.status ?? "unknown").trim() || "unknown",
				statusMessage: String(file.status_message ?? "").trim(),
				disabled: file.disabled === true,
				unavailable: file.unavailable === true,
				success: Number(file.success ?? 0) || 0,
				failed: Number(file.failed ?? 0) || 0,
				// Readable and writable through the management API; `prefix` is
				// writable but not exposed back, so it stays out of the model.
				priority: Number.isFinite(Number(file.priority)) ? Number(file.priority) : null,
				note: typeof file.note === "string" ? file.note : "",
				updatedAt: file.updated_at ?? file.modtime ?? null,
				recentRequests: Array.isArray(file.recent_requests)
					? file.recent_requests.map((bucket) => ({
						time: String(bucket?.time ?? ""),
						success: Number(bucket?.success ?? 0) || 0,
						failed: Number(bucket?.failed ?? 0) || 0
					}))
					: []
			};
		})
		.filter((account) => account.authIndex !== "")
		.filter((account) => wanted === "" || account.provider.toLowerCase() === wanted)
		.filter((account) => config.includeDisabled === true || !account.disabled);
	return { accounts, meta: cpaMetaOf(response.headers) };
}

/**
 * Read the CPA build identity off any management response's headers.
 * @param headers - response headers from a management request.
 * @returns the version record (nulls when the server omits them).
 */
export function cpaMetaOf(headers) {
	const header = (name) => {
		const value = headers?.[name];
		if (Array.isArray(value)) return value[0] ?? null;
		return typeof value === "string" && value !== "" ? value : null;
	};
	return {
		version: header("x-cpa-version"),
		commit: header("x-cpa-commit"),
		buildDate: header("x-cpa-build-date"),
		homeVersion: header("x-cpa-home-version")
	};
}

/** Compare two dotted version strings, tolerating a leading `v` and extra tags. */
export function compareVersions(left, right) {
	const parts = (value) => String(value ?? "").trim().replace(/^v/i, "").split(/[.+-]/).map((part) => Number.parseInt(part, 10));
	const a = parts(left);
	const b = parts(right);
	if (a.length === 0 || b.length === 0 || a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const one = a[index] ?? 0;
		const other = b[index] ?? 0;
		if (one !== other) return one < other ? -1 : 1;
	}
	return 0;
}

/** How long a `/latest-version` answer is trusted before asking again. */
const LATEST_VERSION_TTL_MS = 6 * 3600 * 1000;
/** Shared across runtimes: the upstream release tag is not deployment state. */
let latestVersionCache;

/** Forget the cached upstream release tag (tests). */
export function resetLatestVersionCache() {
	latestVersionCache = undefined;
}

/**
 * Read the newest published CPA release.
 *
 * The CPA host asks GitHub for this, so the answer is cached for hours and a
 * failure degrades to "unknown" rather than failing the whole snapshot.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @returns the release tag, or null when it could not be read.
 */
export async function fetchLatestVersion(client, config) {
	const now = Date.now();
	if (latestVersionCache !== undefined && now - latestVersionCache.at < LATEST_VERSION_TTL_MS) return latestVersionCache.value;
	try {
		const response = await client.request(`${config.baseURL.replace(/\/+$/, "")}${LATEST_VERSION_PATH}`, {
			method: "GET",
			headers: { authorization: bearer(config.managementKey), accept: "application/json" }
		});
		if (response.status !== 200) return latestVersionCache?.value ?? null;
		const body = asJson(response.body);
		const value = typeof body?.["latest-version"] === "string" ? body["latest-version"] : null;
		latestVersionCache = { value, at: now };
		return value;
	} catch {
		return latestVersionCache?.value ?? null;
	}
}

/**
 * Fetch one account's subscription usage through the CPA management API.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL, key, and time zone.
 * @param account - the credential record.
 * @returns the parsed usage model.
 */
export async function fetchUsage(client, config, account) {
	const url = `${config.baseURL.replace(/\/+$/, "")}/v0/management/api-call`;
	const headers = {
		Authorization: "Bearer $TOKEN$",
		Accept: "application/json"
	};
	if (account.accountId !== "") headers["ChatGPT-Account-Id"] = account.accountId;
	const response = await client.request(url, {
		method: "POST",
		headers: {
			authorization: bearer(config.managementKey),
			"content-type": "application/json"
		},
		body: JSON.stringify({ auth_index: account.authIndex, method: "GET", url: USAGE_URL, header: headers })
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error(`management key rejected (HTTP ${String(response.status)})`);
	}
	if (response.status !== 200) {
		return {
			ok: false,
			error: `api-call returned HTTP ${String(response.status)}: ${preview(response.body)}`,
			plan: EMPTY_TEXT,
			windows: [],
			short: null,
			long: null
		};
	}
	const envelope = asJson(response.body);
	if (envelope === undefined) {
		return { ok: false, error: "api-call returned a non-JSON body", plan: EMPTY_TEXT, windows: [], short: null, long: null };
	}
	return parseUsage(envelope, config.timeZone);
}

/**
 * Minimum remaining percentage across the windows we can see.
 * @param usage - a parsed usage model.
 * @returns the percentage, or null when nothing is known.
 */
function minRemaining(usage) {
	const values = usage.windows
		.map((window) => window.remaining)
		.filter((value) => typeof value === "number" && Number.isFinite(value));
	return values.length === 0 ? null : Math.min(...values);
}

/** Management paths this module talks to. */
const LATEST_VERSION_PATH = "/v0/management/latest-version";
const STATUS_PATH = "/v0/management/auth-files/status";
const FIELDS_PATH = "/v0/management/auth-files/fields";
const ERROR_LOGS_PATH = "/v0/management/request-error-logs";
const REQUEST_LOG_PATH = "/v0/management/request-log";

/**
 * Turn one credential's disabled flag into CPA's `PATCH /auth-files/status`.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param name - the credential's file name.
 * @param disabled - the state to store.
 */
export async function setAccountDisabled(client, config, name, disabled) {
	await managementWrite(client, config, STATUS_PATH, { name, disabled });
}

/**
 * Turn a note / priority edit into CPA's `PATCH /auth-files/fields`.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param name - the credential's file name.
 * @param patch - the fields to store; untouched fields are omitted entirely.
 */
export async function setAccountFields(client, config, name, patch) {
	const body = { name };
	if (patch.note !== undefined) body.note = patch.note;
	if (patch.priority !== undefined) body.priority = patch.priority;
	if (Object.keys(body).length === 1) throw new CpaInputError("no field to write");
	await managementWrite(client, config, FIELDS_PATH, body);
}

/**
 * Perform one credential write, surfacing CPA's own error text.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param path - the management path to PATCH.
 * @param body - the JSON request body.
 * @throws {Error} naming the path and the upstream error when the write fails.
 */
async function managementWrite(client, config, path, body) {
	const response = await client.request(`${config.baseURL.replace(/\/+$/, "")}${path}`, {
		method: "PATCH",
		headers: { authorization: bearer(config.managementKey), "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	if (response.status !== 200) {
		throw new Error(`${path} returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	}
	const parsed = asJson(response.body);
	if (parsed !== undefined && parsed.success === false) throw new Error(`${path} rejected the write: ${preview(response.body)}`);
	return parsed;
}

/**
 * Pull every `{"error": …}` payload out of a log body.
 *
 * Brace-balanced rather than a regex lookalike: the payload CPA writes is
 * `{"error":{…},"sequence_number":2}`, so nothing that assumes two adjacent
 * closing braces matches it — and a nested error body has to survive too.
 *
 * @param text - the log body.
 * @returns each payload that parsed, in file order.
 */
function extractErrorPayloads(text) {
	const marker = '{"error":';
	const found = [];
	let index = text.indexOf(marker);
	while (index !== -1) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let at = index; at < text.length; at += 1) {
			const character = text[at];
			if (inString) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') inString = false;
				continue;
			}
			if (character === '"') inString = true;
			else if (character === "{") depth += 1;
			else if (character === "}") {
				depth -= 1;
				if (depth === 0) {
					try {
						found.push(JSON.parse(text.slice(index, at + 1)));
					} catch {
						// A malformed payload is not worth failing the whole log for.
					}
					break;
				}
			}
		}
		index = text.indexOf(marker, index + marker.length);
	}
	return found;
}

/** One error-log file name, as CPA writes it. */
const ERROR_LOG_NAME = /^error-v1-(.+)-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-([0-9a-f]+)\.log$/;

/**
 * Read the trailing status/error summary CPA appends to an error log.
 * @param text - the full log body.
 * @returns the status code and the upstream error triple, where present.
 */
function summarizeErrorLog(text) {
	const status = /^Status:\s*(\d{3})\s*$/m.exec(text)?.[1];
	// The last payload is the one the client actually received.
	const error = extractErrorPayloads(text).reverse().find((entry) => entry?.error !== undefined)?.error;
	return {
		status: status === undefined ? null : Number(status),
		errorType: typeof error?.type === "string" ? error.type : null,
		errorCode: typeof error?.code === "string" ? error.code : null,
		errorMessage: typeof error?.message === "string" ? error.message : null
	};
}

/**
 * Attribute an error log to the credentials it went through, and summarize it.
 *
 * CPA stamps each upstream attempt with
 * `Auth: provider=…, auth_id=<file name>, label=<email>, type=…`, which is the
 * same file name every credential write addresses — so the log lines up with the
 * account cards instead of being an opaque dump.
 *
 * @param name - the log file name.
 * @param text - the log body.
 * @returns the parsed summary and the accounts the request touched.
 */
export function parseErrorLog(name, text) {
	const match = ERROR_LOG_NAME.exec(name);
	const stamp = match === null ? null : `${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}`;
	const parsed = stamp === null ? Number.NaN : Date.parse(`${stamp}Z`);
	// One block per upstream attempt, each stamped with the credential it used:
	// the account a failure belongs to is the whole point of reading the log.
	const attempts = [];
	for (const block of text.split(/^=== API REQUEST \d+ ===$/m).slice(1)) {
		const auth = /^Auth:\s*provider=([^,]+),\s*auth_id=([^,]+),\s*label=([^,]*)/m.exec(block);
		if (auth === null) continue;
		attempts.push({
			provider: auth[1].trim(),
			authId: auth[2].trim(),
			label: auth[3].trim(),
			accountId: /^Chatgpt-Account-Id:\s*(\S+)\s*$/m.exec(block)?.[1] ?? null,
			upstreamUrl: /^Upstream URL:\s*(\S+)\s*$/m.exec(block)?.[1] ?? null
		});
	}
	const accounts = [];
	for (const attempt of attempts) {
		if (accounts.some((entry) => entry.authId === attempt.authId)) continue;
		accounts.push({ provider: attempt.provider, authId: attempt.authId, label: attempt.label, accountId: attempt.accountId });
	}
	return {
		name,
		endpoint: /^URL:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null,
		method: /^Method:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null,
		at: Number.isNaN(parsed) ? null : parsed,
		upstreamUrl: attempts[0]?.upstreamUrl ?? null,
		model: /^\{\s*"instructions".*?"model":"([^"]+)"/ms.exec(text)?.[1] ?? /^\{\s*"model":"([^"]+)"/m.exec(text)?.[1] ?? null,
		attempts,
		...summarizeErrorLog(text),
		accounts
	};
}

/**
 * List CPA's failed-request logs, newest first.
 *
 * CPA records failures in the error-log directory only while `request-log` is
 * off; when it is on, failures live in the request log instead and this listing
 * comes back empty — so the flag is reported alongside, and the UI says why the
 * list is empty rather than implying there were no failures.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param limit - how many entries to keep.
 * @returns the log entries and whether request logging is on.
 */
export async function listErrorLogs(client, config, limit = 20) {
	const headers = { authorization: bearer(config.managementKey), accept: "application/json" };
	const [logs, flag] = await Promise.all([
		client.request(`${config.baseURL.replace(/\/+$/, "")}${ERROR_LOGS_PATH}`, { method: "GET", headers }),
		client
			.request(`${config.baseURL.replace(/\/+$/, "")}${REQUEST_LOG_PATH}`, { method: "GET", headers })
			.catch(() => undefined)
	]);
	if (logs.status !== 200) throw new Error(`${ERROR_LOGS_PATH} returned HTTP ${String(logs.status)}: ${preview(logs.body)}`);
	const files = asJson(logs.body)?.files;
	const entries = (Array.isArray(files) ? files : [])
		.map((file) => {
			const name = String(file?.name ?? "");
			const match = ERROR_LOG_NAME.exec(name);
			const stamp = match === null ? null : Date.parse(`${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}Z`);
			return {
				name,
				size: Number(file?.size ?? 0) || 0,
				modified: Number(file?.modified ?? 0) || null,
				endpoint: match === null ? null : match[1],
				at: stamp === null || Number.isNaN(stamp) ? null : stamp
			};
		})
		.filter((entry) => entry.name !== "")
		.sort((left, right) => (right.at ?? right.modified ?? 0) - (left.at ?? left.modified ?? 0))
		.slice(0, limit);
	const requestLog = asJson(flag?.body)?.["request-log"];
	return { files: entries, requestLogEnabled: requestLog === true };
}

/** Cap on how much log text is shipped to the browser. */
const ERROR_LOG_TEXT_LIMIT = 24_000;

/**
 * Read one error log verbatim, with its parsed summary.
 *
 * The name must both match CPA's own naming scheme and appear in the live
 * listing, which is what keeps a caller from walking the CPA host's filesystem.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param name - the log file name, already validated by the caller.
 * @returns the summary, the accounts involved, and the (possibly truncated) text.
 */
export async function readErrorLog(client, config, name) {
	if (!ERROR_LOG_NAME.test(name)) throw new CpaInputError(`refusing to read "${name}": not an error-log name`);
	const listed = await listErrorLogs(client, config, 200);
	if (!listed.files.some((entry) => entry.name === name)) throw new CpaInputError(`refusing to read "${name}": not in the current listing`);
	const response = await client.request(`${config.baseURL.replace(/\/+$/, "")}${ERROR_LOGS_PATH}/${encodeURIComponent(name)}`, {
		method: "GET",
		headers: { authorization: bearer(config.managementKey) }
	});
	if (response.status !== 200) throw new Error(`reading ${name} returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	const text = typeof response.body === "string" ? response.body : "";
	return {
		...parseErrorLog(name, text),
		size: text.length,
		truncated: text.length > ERROR_LOG_TEXT_LIMIT,
		text: text.length > ERROR_LOG_TEXT_LIMIT ? `${text.slice(0, ERROR_LOG_TEXT_LIMIT)}\n… (truncated)` : text
	};
}

/**
 * Collect one full snapshot: every account plus its usage.
 *
 * Usage fetches run concurrently; a per-account failure is recorded on that
 * account instead of failing the whole snapshot, so one expired token never
 * blanks the panel.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - resolved plugin config.
 * @returns the snapshot the routes serve and the panel renders.
 */
export async function collectSnapshot(client, config) {
	const startedAt = Date.now();
	const errors = [];
	const listed = await listAccounts(client, config);
	const credentials = listed.accounts;
	const latestVersion = await fetchLatestVersion(client, config);
	const results = await Promise.all(
		credentials.map(async (account) => {
			try {
				const usage = await fetchUsage(client, config, account);
				return { account, usage };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${account.email || account.authIndex}: ${message}`);
				return {
					account,
					usage: { ok: false, error: message, plan: account.claimPlan ?? EMPTY_TEXT, windows: [], short: null, long: null }
				};
			}
		})
	);
	const accounts = results.map(({ account, usage }) => {
		const usable = usage.ok && !account.disabled && !account.unavailable && account.status === "active";
		return {
			authIndex: account.authIndex,
			name: account.name,
			email: account.email,
			accountId: account.accountId,
			provider: account.provider,
			status: account.status,
			statusMessage: account.statusMessage,
			disabled: account.disabled,
			unavailable: account.unavailable,
			usable,
			plan: usage.plan === EMPTY_TEXT ? (account.claimPlan ?? EMPTY_TEXT) : usage.plan,
			priority: account.priority,
			note: account.note,
			updatedAt: account.updatedAt,
			success: account.success,
			failed: account.failed,
			recentRequests: account.recentRequests,
			windows: usage.windows,
			short: usage.short,
			long: usage.long,
			summary: usage.ok ? summaryValue(usage) : EMPTY_TEXT,
			minRemaining: minRemaining(usage),
			limitReached: usage.limitReached === true || account.status === "error",
			allowed: usage.allowed !== false,
			rateLimitReachedType: usage.rateLimitReachedType ?? null,
			credits: usage.credits ?? null,
			resetCredits: usage.resetCredits ?? 0,
			error: usage.error
		};
	});
	const enabled = accounts.filter((account) => !account.disabled);
	const remaining = enabled
		.map((account) => account.minRemaining)
		.filter((value) => typeof value === "number" && Number.isFinite(value));
	const counts = {
		total: accounts.length,
		active: accounts.filter((account) => account.usable).length,
		error: accounts.filter((account) => !account.disabled && !account.usable).length,
		disabled: accounts.filter((account) => account.disabled).length
	};
	return {
		ok: true,
		source: "cpa",
		baseURL: config.baseURL,
		providerFilter: config.providerFilter,
		// The CPA build this snapshot came from, plus the newest release when the
		// host could reach GitHub. `compareVersions` returns null for an unparsable
		// tag, which reads as "do not claim an update is available".
		cpa: {
			...listed.meta,
			latestVersion,
			updateAvailable: latestVersion !== null && compareVersions(listed.meta.version, latestVersion) === -1
		},
		proxy: client.proxy ?? "unknown",
		transport: client.attempts,
		fetchedAt: Date.now(),
		durationMs: Date.now() - startedAt,
		accounts,
		counts,
		minRemaining: remaining.length === 0 ? null : Math.min(...remaining),
		attention: accounts.filter(
			(account) => !account.disabled && (!account.usable || account.limitReached || (account.minRemaining !== null && account.minRemaining <= 10))
		).length,
		errors
	};
}
