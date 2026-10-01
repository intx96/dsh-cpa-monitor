/**
 * dsh-cpa-monitor — CLIProxyAPI (CPA) domain logic.
 *
 * Ports the reference Python collector (`update-plus.py`) and extends it: the
 * account list is discovered from the management API instead of being
 * hardcoded, and each account also carries its CPA health (status, disabled,
 * success/failed counters, recent request buckets).
 *
 * CPA management surface used here:
 *   GET  <management>/credentials    → every credential, with `auth_index`,
 *                                      `id_token.chatgpt_account_id`, `status`
 *   POST <management>/api-call       → proxied upstream call; `$TOKEN$` in a
 *                                      header is replaced with that credential's
 *                                      access token
 *
 * @module dsh-cpa-monitor/cpa
 */

/** Upstream usage endpoint, addressed through `api-call`. */
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * Where the banked rate-limit resets live, with their expiry.
 *
 * A SEPARATE upstream endpoint from the usage one: the usage payload only carries
 * `rate_limit_reset_credits.available_count`, so the per-credit expiry the panel
 * wants is not obtainable there at all. Verified against a live Codex account.
 */
export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

/** Parse an ISO instant into epoch milliseconds, accepting camelCase payloads. */
function instantOf(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
	if (typeof value !== "string" || value === "") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

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
		resetCredits: Number(body.rate_limit_reset_credits?.available_count ?? 0) || 0,
		// Passed through untouched: the panel lists the individual credits and their
		// expiry, and this payload is upstream-shaped rather than part of CPA's own
		// management contract, so nothing here renames its keys.
		resetCreditsDetail: body.rate_limit_reset_credits ?? null
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
	const surface = await managementSurface(client, config);
	const url = `${origin(config)}${surface.credentials}`;
	const response = await client.request(url, {
		method: "GET",
		headers: { authorization: bearer(config.managementKey), accept: "application/json" }
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error(`management key rejected (HTTP ${String(response.status)})`);
	}
	if (response.status !== 200) {
		throw new Error(`${surface.credentials} returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	}
	const payload = asJson(response.body);
	const files = Array.isArray(payload?.files) ? payload.files : undefined;
	if (files === undefined) throw new Error(`${surface.credentials} response has no \`files\` array`);
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
				// CPA's own cooldown bookkeeping: what it decided locally after an
				// upstream 429, per credential and per model. This is routing state,
				// not the upstream quota — `retry_at` is when CPA will try again.
				cooldowns: Array.isArray(file.cooldowns)
					? file.cooldowns.map((entry) => ({
						scope: String(entry?.scope ?? "").trim() || "credential",
						reason: entry?.reason ?? null,
						modelKey: entry?.model_key ?? entry?.modelKey ?? null,
						retryAt: instantOf(entry?.retry_at ?? entry?.retryAt),
						remainingSeconds: Number.isFinite(Number(entry?.remaining_seconds ?? entry?.remainingSeconds))
							? Number(entry?.remaining_seconds ?? entry?.remainingSeconds)
							: null,
						httpStatus: Number.isFinite(Number(entry?.http_status ?? entry?.httpStatus)) ? Number(entry?.http_status ?? entry?.httpStatus) : null,
						backoffLevel: Number.isFinite(Number(entry?.backoff_level ?? entry?.backoffLevel)) ? Number(entry?.backoff_level ?? entry?.backoffLevel) : null
					}))
					: [],
				nextRetryAfter: instantOf(file.next_retry_after ?? file.nextRetryAfter),
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
	return { accounts, meta: { ...cpaMetaOf(response.headers), api: surface.id } };
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
		const surface = await managementSurface(client, config);
		const response = await client.request(`${origin(config)}${surface.latestVersion}`, {
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
/**
 * Ask CPA to call one upstream URL with a credential's token.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param account - the credential whose token signs the call.
 * @param url - the absolute upstream URL.
 * @param headers - extra upstream headers; `$TOKEN$` is replaced by CPA.
 * @returns the api-call envelope (`status_code`, `header`, `body`).
 */
async function callUpstream(client, config, account, url, headers) {
	const surface = await managementSurface(client, config);
	return client.request(`${origin(config)}${surface.apiCall}`, {
		method: "POST",
		headers: {
			authorization: bearer(config.managementKey),
			"content-type": "application/json"
		},
		body: JSON.stringify({
			auth_index: account.authIndex,
			method: "GET",
			url,
			header: {
				Authorization: "Bearer $TOKEN$",
				Accept: "application/json",
				...(account.accountId === "" ? {} : { "ChatGPT-Account-Id": account.accountId }),
				...headers
			}
		})
	});
}

/**
 * List one credential's banked reset credits, with their expiry.
 *
 * Read-only, and deliberately on demand rather than on every poll: the upstream
 * endpoint rate-limits queries, and the panel only needs this when a reader opens
 * the credits disclosure.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param account - the credential to read.
 * @returns `{ ok, availableCount, totalEarnedCount, credits }` or `{ ok: false, error }`.
 */
export async function fetchResetCredits(client, config, account) {
	try {
		const response = await callUpstream(client, config, account, RESET_CREDITS_URL, {
			// The upstream endpoint expects the Codex client's own product headers.
			originator: "Codex Desktop",
			"OAI-Product-Sku": "CODEX"
		});
		if (response.status === 401 || response.status === 403) {
			throw new Error(`management key rejected (HTTP ${String(response.status)})`);
		}
		if (response.status !== 200) throw new Error(`api-call returned HTTP ${String(response.status)}: ${preview(response.body)}`);
		const envelope = asJson(response.body);
		const body = asJson(envelope?.body);
		if (body === undefined) throw new Error("reset-credits returned a non-JSON body");
		const list = Array.isArray(body.credits) ? body.credits : [];
		return {
			ok: true,
			error: null,
			availableCount: Number(body.available_count ?? body.availableCount ?? 0) || 0,
			totalEarnedCount: Number(body.total_earned_count ?? body.totalEarnedCount ?? 0) || 0,
			credits: list.map((credit) => ({
				id: String(credit?.id ?? ""),
				status: credit?.status ?? null,
				resetType: credit?.reset_type ?? credit?.resetType ?? null,
				title: credit?.title ?? null,
				grantedAt: instantOf(credit?.granted_at ?? credit?.grantedAt),
				expiresAt: instantOf(credit?.expires_at ?? credit?.expiresAt),
				redeemedAt: instantOf(credit?.redeemed_at ?? credit?.redeemedAt)
			}))
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), availableCount: 0, totalEarnedCount: 0, credits: [] };
	}
}

/**
 * Force CPA to refresh one credential's OAuth token.
 *
 * v8 only — the route does not exist on v0 — and single-credential only: the
 * handler accepts `all: true`, which re-runs every credential's refresh at once,
 * and this plugin never asks for that. CPA requires `name`; `auth_index` is only a
 * lookup hint.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param name - the credential's file name.
 * @returns CPA's answer, carrying the refreshed record.
 */
export async function refreshCredential(client, config, name) {
	const surface = await managementSurface(client, config);
	if (surface.id !== "v8") throw new CpaInputError("refreshing OAuth credentials requires the v8 management API");
	const response = await client.request(`${origin(config)}${surface.refresh}`, {
		method: "POST",
		headers: { authorization: bearer(config.managementKey), "content-type": "application/json" },
		body: JSON.stringify({ name })
	});
	if (response.status !== 200) {
		throw new Error(`${surface.refresh} returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	}
	return asJson(response.body) ?? null;
}

/** Fetch one account's subscription usage through the CPA management API. */
export async function fetchUsage(client, config, account) {
	const response = await callUpstream(client, config, account, USAGE_URL, {});
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

/**
 * The management API generations this plugin can speak, newest first.
 *
 * CPA 8 introduced `/v8/management` and documents `/v0/management` as near
 * deprecation, but keeps answering v0 — which is the only reason this plugin
 * worked on v8 while it still spoke v0 alone. Every call therefore prefers v8 and
 * falls back to v0, so one build serves both. Two things have no v8 equivalent:
 * the `request-log` flag is a config node there rather than a route, and v8's
 * `/credentials` listing may carry fewer per-credential fields — both are read
 * defensively rather than assumed.
 */
const SURFACES = [
	{
		id: "v8",
		probe: "/v8/management/credentials/quota/providers",
		credentials: "/v8/management/credentials",
		status: "/v8/management/credentials/status",
		fields: "/v8/management/credentials/fields",
		apiCall: "/v8/management/requests/api-call",
		latestVersion: "/v8/management/server/latest-version",
		errorLogs: "/v8/management/observability/logs/errors",
		resetQuota: "/v8/management/routing/cooldown/reset",
		refresh: "/v8/management/credentials/refresh",
		requestLog: null
	},
	{
		id: "v0",
		probe: "/v0/management/request-error-logs",
		credentials: "/v0/management/auth-files",
		status: "/v0/management/auth-files/status",
		fields: "/v0/management/auth-files/fields",
		apiCall: "/v0/management/api-call",
		latestVersion: "/v0/management/latest-version",
		errorLogs: "/v0/management/request-error-logs",
		resetQuota: "/v0/management/reset-quota",
		refresh: null,
		requestLog: "/v0/management/request-log"
	}
];

/** The deployment root every path hangs off. */
function origin(config) {
	return config.baseURL.replace(/\/+$/, "");
}

/**
 * Resolve which generation this deployment answers on, once per client.
 *
 * The probe is a single read-only request that only v8 has — the quota provider
 * directory — and the answer is cached on the client, so a configuration change
 * pays it once instead of every poll. A rejected key throws here rather than
 * quietly falling back, so the panel still blames the key.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @returns the surface to speak from now on.
 */
export async function managementSurface(client, config) {
	if (client.managementSurface !== undefined) return client.managementSurface;
	const response = await client.request(`${origin(config)}${SURFACES[0].probe}`, {
		method: "GET",
		headers: { authorization: bearer(config.managementKey), accept: "application/json" }
	});
	if (response.status === 401 || response.status === 403) {
		throw new Error(`management key rejected (HTTP ${String(response.status)})`);
	}
	client.managementSurface = response.status === 200 ? SURFACES[0] : SURFACES[1];
	return client.managementSurface;
}

/**
 * Turn one credential's disabled flag into CPA's `PATCH /auth-files/status`.
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param name - the credential's file name.
 * @param disabled - the state to store.
 */
export async function setAccountDisabled(client, config, name, disabled) {
	const surface = await managementSurface(client, config);
	await managementWrite(client, config, surface.status, { name, disabled });
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
	const surface = await managementSurface(client, config);
	await managementWrite(client, config, surface.fields, body);
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
	const response = await client.request(`${origin(config)}${path}`, {
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
 * Clear one credential's quota and cooldown state.
 *
 * THIS CONSUMES A RESET CREDIT, which is a scarce, expiring resource: CPA's own
 * docs call the route "重置冷却" and it spends one `rate_limit_reset_credits`
 * entry per call. It is therefore only ever reachable from the panel's explicit
 * two-step confirmation and is never called by the poller, a retry, or any
 * fallback path — see the single call site in `lib/index.js`.
 *
 * @param client - HTTP client from `createHttpClient`.
 * @param config - base URL and key.
 * @param authIndex - the credential to reset.
 * @returns CPA's answer, which names the models it cleared.
 */
export async function resetCooldown(client, config, authIndex) {
	const surface = await managementSurface(client, config);
	const response = await client.request(`${origin(config)}${surface.resetQuota}`, {
		method: "POST",
		headers: { authorization: bearer(config.managementKey), "content-type": "application/json" },
		body: JSON.stringify({ auth_index: authIndex })
	});
	if (response.status !== 200) {
		throw new Error(`${surface.resetQuota} returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	}
	return asJson(response.body) ?? null;
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

/** The instant CPA stamps into a log BODY; unlike the file name it carries its own offset. */
const ERROR_LOG_TIMESTAMP = /^Timestamp:\s*(\S+)\s*$/m;

/**
 * Parse a CPA timestamp into an epoch instant.
 *
 * A stamp that names its zone (`…Z`, `…+08:00`) is authoritative and parsed as
 * written. A bare one — what the FILE NAME carries, with the separators stripped
 * — is left for the runtime to read in the host's own zone.
 *
 * This used to force `Z` onto every stamp, which silently reinterpreted the
 * writer's wall clock as UTC: on a `+08:00` deployment every listed failure came
 * out eight hours late, and a body stamp that already ended in `Z` produced
 * `…ZZ`. The file name is only ever a fallback now — the listing has `modified`
 * and a log body has its `Timestamp:` line, both absolute.
 *
 * @param value - an ISO stamp, with or without a zone designator.
 * @returns the instant in epoch milliseconds, or null when unparseable.
 */
function parseInstant(value) {
	if (typeof value !== "string" || value.trim() === "") return null;
	// Parsed as written: a designator decides the instant, and a bare stamp falls
	// back to the runtime's own zone.
	const parsed = Date.parse(value.trim());
	return Number.isNaN(parsed) ? null : parsed;
}

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
	// The body's own stamp names its zone and the file's does not, so the body
	// wins; the file name stays as the fallback for a body without one.
	const parsed = parseInstant(ERROR_LOG_TIMESTAMP.exec(text)?.[1] ?? stamp ?? "") ?? parseInstant(stamp ?? "");
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
	const surface = await managementSurface(client, config);
	// v8 has no request-log route: the flag lives in its config tree. The v0 route
	// is still answered there, so it is the portable read — and a body without the
	// flag simply leaves the section in its "list is authoritative" state.
	const requestLogPath = surface.requestLog ?? SURFACES[1].requestLog;
	const headers = { authorization: bearer(config.managementKey), accept: "application/json" };
	const [logs, flag] = await Promise.all([
		client.request(`${origin(config)}${surface.errorLogs}`, { method: "GET", headers }),
		client
			.request(`${origin(config)}${requestLogPath}`, { method: "GET", headers })
			.catch(() => undefined)
	]);
	if (logs.status !== 200) throw new Error(`${surface.errorLogs} returned HTTP ${String(logs.status)}: ${preview(logs.body)}`);
	const files = asJson(logs.body)?.files;
	const entries = (Array.isArray(files) ? files : [])
		.map((file) => {
			const name = String(file?.name ?? "");
			const match = ERROR_LOG_NAME.exec(name);
			// `modified` is an absolute epoch second and the file name only carries
			// the writer's wall clock, so the absolute value leads. Reading the name
			// as UTC instead put every listed failure eight hours late on a +08:00
			// deployment.
			const modified = Number(file?.modified ?? 0) || null;
			const fromName = match === null ? null : parseInstant(`${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}`);
			return {
				name,
				size: Number(file?.size ?? 0) || 0,
				modified,
				endpoint: match === null ? null : match[1],
				at: modified === null ? fromName : modified * 1000
			};
		})
		.filter((entry) => entry.name !== "")
		.sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
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
	const surface = await managementSurface(client, config);
	const listed = await listErrorLogs(client, config, 200);
	const entry = listed.files.find((candidate) => candidate.name === name);
	if (entry === undefined) throw new CpaInputError(`refusing to read "${name}": not in the current listing`);
	const response = await client.request(`${origin(config)}${surface.errorLogs}/${encodeURIComponent(name)}`, {
		method: "GET",
		headers: { authorization: bearer(config.managementKey) }
	});
	if (response.status !== 200) throw new Error(`reading ${name} returned HTTP ${String(response.status)}: ${preview(response.body)}`);
	const text = typeof response.body === "string" ? response.body : "";
	const parsed = parseErrorLog(name, text);
	return {
		...parsed,
		// The body's stamp is the most precise source; the listing's absolute
		// `modified` covers a body whose stamp this parser could not read.
		at: parsed.at ?? entry.at ?? null,
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
			cooldowns: account.cooldowns ?? [],
			nextRetryAfter: account.nextRetryAfter ?? null,
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
			resetCreditsDetail: usage.resetCreditsDetail ?? null,
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
