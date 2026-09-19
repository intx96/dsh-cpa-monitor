#!/usr/bin/env node
/**
 * Integration test for the server half.
 *
 * Boots the real plugin inside a real Cordis context, with the real
 * `SettingsProvider` (memory-backed) and a stub `webServer`, so namespace
 * registration, schema resolution, layered precedence, validation, redaction,
 * `watch`-driven live reconfiguration, the loopback fence, and the action-header
 * guard are all the shipped implementations rather than mocks.
 *
 * The snapshot route reaches the real CPA through the configured proxy. When
 * that is unreachable the test still passes but asserts the error payload — a
 * failed refresh must surface its transport error, never throw.
 *
 *   node scripts/smoke-server.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readEffectiveConfig } from "./patch-config.mjs";
import {
	apply,
	inject as pluginInject,
	Config,
	normalizeEntryConfig,
	SETTINGS_NAMESPACE,
	SNAPSHOT_PATH,
	REFRESH_PATH,
	ACCOUNT_PATH,
	DIAGNOSTICS_PATH,
	ACTION_HEADER as composeActionHeader
} from "../lib/index.js";
import { parseErrorLog, resetLatestVersionCache } from "../lib/cpa.js";

const DSH_LIB = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const { Context, Service } = await import(`${DSH_LIB}/cordis/lib/index.js`);
const { SettingsProvider } = await import(`${DSH_LIB}/dsh-settings/lib/index.js`);

const here = dirname(fileURLToPath(import.meta.url));
// Offline inputs: captures taken from the live deployment by
// `scripts/capture-fixtures.mjs`, so the route tests need no network.
const fixture = (name, asText = false) => {
	const body = readFileSync(join(here, "..", "test", "fixtures", name), asText ? "utf8" : undefined);
	return asText ? body : JSON.parse(body);
};
// The live boot resolves the same layered configuration the plugin does
// (composition patch → user settings), so it exercises a real deployment when
// this machine has one and degrades gracefully when it does not.
const compositionConfig = normalizeEntryConfig(readEffectiveConfig());
// A hermetic config for the fake-CPA suite: no real endpoint, no real key, so
// those assertions never depend on this machine's deployment.
const fakeConfig = normalizeEntryConfig({
	baseURL: "https://fake.invalid:8317",
	managementKey: "fake-management-key",
	proxies: [],
	allowDirect: true
});

const checks = [];
/**
 * Record one assertion.
 * @param label - what was checked.
 * @param ok - the result.
 * @param detail - context printed on failure.
 */
function check(label, ok, detail) {
	checks.push({ label, ok: Boolean(ok) });
	process.stdout.write(`${ok ? "  ok   " : "  FAIL "} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}\n`);
}

/** Let queued microtasks and cordis effect callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A stand-in CPA transport.
 *
 * Every route the plugin talks to answers from a fixture, and writes are
 * journaled instead of performed — the write paths must be provable without
 * mutating the real proxy these tests also run against.
 */
function createFakeCpa() {
	const writes = [];
	const reads = [];
	const usageBody = (accountId) =>
		JSON.stringify({
			account_id: accountId,
			email: "fixture@example.com",
			plan_type: "plus",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1789673663 },
				secondary_window: { used_percent: 91, limit_window_seconds: 604800, reset_after_seconds: 200, reset_at: 1789806697 }
			},
			credits: { has_credits: false, unlimited: false, balance: "0", overage_limit_reached: false },
			rate_limit_reset_credits: { available_count: 1 }
		});
	const authFiles = {
		files: [
			{
				auth_index: "fake-one",
				name: "codex-fake-one.json",
				email: "one@example.com",
				provider: "codex",
				status: "active",
				disabled: false,
				priority: 5,
				note: "primary",
				id_token: { chatgpt_account_id: "acct-one", plan_type: "plus" },
				recent_requests: []
			},
			{
				auth_index: "fake-two",
				name: "codex-fake-two.json",
				email: "two@example.com",
				provider: "codex",
				status: "disabled",
				disabled: true,
				priority: 0,
				id_token: { chatgpt_account_id: "acct-two", plan_type: "plus" },
				recent_requests: []
			}
		]
	};
	const errorLogs = fixture("error-logs.json");
	const errorLogText = fixture("error-log.txt", true);
	return {
		writes,
		reads,
		client: {
			proxy: "fake",
			attempts: [],
			reset() {},
			async request(url, options = {}) {
				const path = new URL(url).pathname;
				const method = (options.method ?? "GET").toUpperCase();
				reads.push(`${method} ${path}`);
				if (method === "PATCH") {
					writes.push({ path, body: JSON.parse(options.body) });
					return { status: 200, headers: {}, body: JSON.stringify({ success: true }) };
				}
				if (path.endsWith("/auth-files")) {
					return {
						status: 200,
						headers: { "x-cpa-version": "7.2.159", "x-cpa-commit": "ac02da6c" },
						body: JSON.stringify(authFiles)
					};
				}
				if (path.endsWith("/api-call")) return { status: 200, headers: {}, body: JSON.stringify({ status_code: 200, body: usageBody("acct-one") }) };
				if (path.endsWith("/latest-version")) return { status: 200, headers: {}, body: JSON.stringify({ "latest-version": "v7.3.7" }) };
				if (path.endsWith("/request-error-logs")) return { status: 200, headers: {}, body: JSON.stringify(errorLogs) };
				if (path.endsWith("/request-log")) return { status: 200, headers: {}, body: JSON.stringify({ "request-log": false }) };
				if (path.includes("/request-error-logs/")) return { status: 200, headers: {}, body: errorLogText };
				return { status: 404, headers: {}, body: JSON.stringify({ error: `unrouted ${path}` }) };
			}
		}
	};
}

/** Stub `webServer` service: the same `register` contract, an in-memory table. */
class FakeWebServer extends Service {
	constructor(ctx) {
		super(ctx, "webServer");
		this.routes = new Map();
		this.registered = [];
	}

	register(route) {
		if (this.routes.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`);
		this.routes.set(route.path, route);
		this.registered.push(route.path);
		return () => this.routes.delete(route.path);
	}
}

/** The real settings provider with in-memory storage instead of a YAML file. */
class MemorySettings extends SettingsProvider {
	document = {};

	get writable() {
		return true;
	}

	async load() {
		return structuredClone(this.document);
	}

	async persist(ns, section) {
		this.document[ns] = structuredClone(section);
	}
}

/**
 * Boot a Cordis app with the stub web server, optionally the settings provider.
 * @param options - whether to compose the settings service.
 * @returns the started app context.
 */
async function boot({ withSettings = true, client, config = compositionConfig } = {}) {
	const app = new Context();
	app.plugin(FakeWebServer);
	if (withSettings) app.plugin(MemorySettings);
	const deps = client === undefined ? {} : { createClient: () => client };
	await app.plugin(
		{
			name: "cpa-monitor",
			inject: pluginInject,
			Config,
			apply: (ctx, config) => apply(ctx, config, deps)
		},
		config
	);
	await settle();
	await settle();
	return app;
}

/**
 * Build a fake request/response pair.
 * @param options - path, method, peer address, and headers.
 * @returns the request and a promise for the captured response.
 */
function makeExchange(options = {}) {
	const listeners = new Map();
	const req = {
		url: options.path ?? SNAPSHOT_PATH,
		method: options.method ?? "GET",
		headers: options.headers ?? {},
		socket: { remoteAddress: options.peer ?? "127.0.0.1" },
		on(event, handler) {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
			return req;
		},
		destroy() {}
	};
	const emit = (event, value) => {
		for (const handler of listeners.get(event) ?? []) handler(value);
	};
	// Deliver the body on a later tick, the way a socket does.
	queueMicrotask(() => {
		if (options.body !== undefined) emit("data", Buffer.from(options.body, "utf8"));
		emit("end");
	});
	let settleResponse;
	const done = new Promise((resolve) => {
		settleResponse = resolve;
	});
	const res = {
		status: 0,
		headers: {},
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers ?? {};
		},
		end(body) {
			settleResponse({ status: this.status, headers: this.headers, json: body === undefined ? undefined : JSON.parse(String(body)) });
		}
	};
	return { req, res, done };
}

/**
 * Invoke a route and await its response.
 * @param handler - the route handler.
 * @param options - exchange options.
 * @returns the captured response.
 */
async function call(handler, options) {
	const exchange = makeExchange(options);
	await handler(exchange.req, exchange.res);
	return exchange.done;
}

//#region wiring
const app = await boot();
const webServer = app.get("webServer");
check("registers the snapshot route", webServer.routes.has(SNAPSHOT_PATH), SNAPSHOT_PATH);
check("registers the refresh route", webServer.routes.has(REFRESH_PATH), REFRESH_PATH);
check("registers all four routes", webServer.registered.length === 4, webServer.registered.join(", "));

const snapshotHandler = webServer.routes.get(SNAPSHOT_PATH).handler;
const refreshHandler = webServer.routes.get(REFRESH_PATH).handler;
//#endregion

//#region settings namespace
const descriptors = app.settings.describe();
const descriptor = descriptors.find((entry) => entry.ns === SETTINGS_NAMESPACE);
check("registers its settings namespace", descriptor !== undefined, descriptors.map((entry) => entry.ns).join(", "));
check("namespace declares live effect timing", descriptor?.applies === "live", String(descriptor?.applies));
check("composition entry became the base layer", descriptor?.base?.baseURL === compositionConfig.baseURL, String(descriptor?.base?.baseURL));
check("schema is serializable for configuration UIs", typeof descriptor?.schema === "object" && descriptor.schema !== null);
check("no user layer yet", descriptor?.user === undefined, JSON.stringify(descriptor?.user));

const redacted = app.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === SETTINGS_NAMESPACE);
check("redacted view drops the management key", redacted?.value?.managementKey === undefined, JSON.stringify(redacted?.value)?.slice(0, 120));
check(
	"redacted view enumerates the secret position",
	Array.isArray(redacted?.secrets) && redacted.secrets.some((secret) => (secret.path ?? []).includes("managementKey")),
	JSON.stringify(redacted?.secrets)
);
check("resolved value keeps the key owner-side", app.settings.get(SETTINGS_NAMESPACE)?.managementKey === compositionConfig.managementKey);
//#endregion

//#region guards
const foreign = await call(snapshotHandler, { peer: "10.0.0.7" });
check("rejects a non-loopback peer", foreign.status === 403, `HTTP ${String(foreign.status)}`);
check("non-loopback rejection is JSON with an error", typeof foreign.json?.error === "string", JSON.stringify(foreign.json));

const missingHeader = await call(refreshHandler, { path: REFRESH_PATH });
check("refresh without the action header is rejected", missingHeader.status === 400, `HTTP ${String(missingHeader.status)}`);
check("rejection names the required header", String(missingHeader.json?.error).includes("x-dsh-cpa-monitor-action"), JSON.stringify(missingHeader.json));

const forcedWithoutHeader = await call(snapshotHandler, { path: `${SNAPSHOT_PATH}?refresh=1` });
check("snapshot?refresh=1 without the header is rejected too", forcedWithoutHeader.status === 400, `HTTP ${String(forcedWithoutHeader.status)}`);
//#endregion

//#region live reconfiguration
const before = await call(snapshotHandler, { path: SNAPSHOT_PATH });
check("payload exposes the effective config", before.json?.config?.baseURL === compositionConfig.baseURL, JSON.stringify(before.json?.config)?.slice(0, 160));
check(
	"payload advertises the capabilities the browser gates on",
	JSON.stringify(before.json?.capabilities) === JSON.stringify(["account", "diagnostics", "cpa"]),
	JSON.stringify(before.json?.capabilities)
);
// The contract is that the key state is reported and the key itself never is —
// whether this deployment HAS one is not something a package test can assert.
check(
	"payload reports the key state without ever revealing the key",
	typeof before.json?.config?.managementKeyConfigured === "boolean" && before.json?.config?.managementKey === undefined,
	JSON.stringify(before.json?.config)
);
if (before.json?.config?.managementKeyConfigured !== true) {
	process.stdout.write("  note   no management key configured here; live checks will report themselves skipped\n");
}
check("payload reports the poll interval", before.json?.intervalMs === compositionConfig.refreshIntervalMs, String(before.json?.intervalMs));

await app.settings.update(SETTINGS_NAMESPACE, { refreshIntervalMs: 45000 });
await settle();
const afterInterval = await call(snapshotHandler, { path: SNAPSHOT_PATH });
check("a saved interval reaches the runtime live", afterInterval.json?.intervalMs === 45000, String(afterInterval.json?.intervalMs));
check(
	"the user layer now carries the override",
	app.settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)?.user?.refreshIntervalMs === 45000
);

await app.settings.update(SETTINGS_NAMESPACE, { baseURL: "https://cpa.example.invalid:8317", proxies: ["http://127.0.0.1:1080"] });
await settle();
const afterAddress = await call(snapshotHandler, { path: SNAPSHOT_PATH });
check(
	"a saved CPA address reaches the runtime live",
	afterAddress.json?.config?.baseURL === "https://cpa.example.invalid:8317",
	String(afterAddress.json?.config?.baseURL)
);
check(
	"a saved proxy list reaches the runtime live",
	JSON.stringify(afterAddress.json?.config?.proxies) === JSON.stringify(["http://127.0.0.1:1080"]),
	JSON.stringify(afterAddress.json?.config?.proxies)
);

// Validation must refuse a write, not merely warn about it.
let rejectedProxy;
try {
	await app.settings.update(SETTINGS_NAMESPACE, { proxies: ["ftp://127.0.0.1:21"] });
} catch (error) {
	rejectedProxy = error instanceof Error ? error.message : String(error);
}
check("an unsupported proxy scheme is refused", typeof rejectedProxy === "string" && rejectedProxy.includes("无法解析的代理地址"), String(rejectedProxy));
check(
	"the refused write left the config alone",
	JSON.stringify(app.settings.get(SETTINGS_NAMESPACE).proxies) === JSON.stringify(["http://127.0.0.1:1080"]),
	JSON.stringify(app.settings.get(SETTINGS_NAMESPACE).proxies)
);

let inverted;
try {
	await app.settings.update(SETTINGS_NAMESPACE, { connectTimeoutMs: 60000, timeoutMs: 20000 });
} catch (error) {
	inverted = error instanceof Error ? error.message : String(error);
}
check("connectTimeoutMs > timeoutMs is refused", typeof inverted === "string" && inverted.includes("不能大于"), String(inverted));

let badZone;
try {
	await app.settings.update(SETTINGS_NAMESPACE, { timeZone: "Mars/Olympus" });
} catch (error) {
	badZone = error instanceof Error ? error.message : String(error);
}
check("an unknown time zone is refused", typeof badZone === "string" && badZone.includes("无法识别的时区"), String(badZone));

// A bare host:port is a deliberate convenience, so make sure it stays accepted.
await app.settings.update(SETTINGS_NAMESPACE, { proxies: ["127.0.0.1:1080"] });
await settle();
const bare169 = await call(snapshotHandler, { path: SNAPSHOT_PATH });
check(
	"a bare host:port proxy is accepted",
	JSON.stringify(bare169.json?.config?.proxies) === JSON.stringify(["127.0.0.1:1080"]),
	JSON.stringify(bare169.json?.config?.proxies)
);

await app.settings.replace(SETTINGS_NAMESPACE, {});
await settle();
const afterReset = await call(snapshotHandler, { path: SNAPSHOT_PATH });
check("reset re-inherits the composition entry", afterReset.json?.config?.baseURL === compositionConfig.baseURL, String(afterReset.json?.config?.baseURL));
check("reset restored the poll interval", afterReset.json?.intervalMs === compositionConfig.refreshIntervalMs, String(afterReset.json?.intervalMs));
//#endregion

//#region live snapshot
const startedAt = Date.now();
const first = await call(snapshotHandler, { path: SNAPSHOT_PATH });
const elapsed = Date.now() - startedAt;
check("snapshot answers HTTP 200", first.status === 200, `HTTP ${String(first.status)}`);
check("snapshot payload carries `ok` and `ageMs`", typeof first.json?.ok === "boolean" && "ageMs" in (first.json ?? {}));

if (first.json?.ok === true) {
	const snapshot = first.json.snapshot;
	check(
		"live snapshot has a CPA source and transport",
		snapshot.source === "cpa" && typeof snapshot.proxy === "string",
		JSON.stringify({ source: snapshot.source, proxy: snapshot.proxy })
	);
	check("live snapshot discovered at least one account", Array.isArray(snapshot.accounts) && snapshot.accounts.length > 0, String(snapshot.accounts?.length));
	check("every account carries an authIndex", snapshot.accounts.every((account) => typeof account.authIndex === "string" && account.authIndex !== ""));
	check("every account carries counts and a summary", snapshot.accounts.every((account) => typeof account.summary === "string" && typeof account.success === "number"));
	check("counts add up", snapshot.counts.total === snapshot.accounts.length, JSON.stringify(snapshot.counts));
	process.stdout.write(`  info   live snapshot via ${snapshot.proxy} in ${String(snapshot.durationMs)}ms (route ${String(elapsed)}ms)\n`);
} else {
	check("offline payload explains the failure", typeof first.json?.error === "string" && first.json.error !== "", JSON.stringify(first.json)?.slice(0, 240));
	process.stdout.write(`  skip   CPA unreachable from here (${String(first.json?.error)?.slice(0, 100)})\n`);
}

const second = await call(snapshotHandler, { path: SNAPSHOT_PATH });
check(
	"a second read is served from cache",
	second.status === 200 && second.json?.snapshot?.fetchedAt === first.json?.snapshot?.fetchedAt,
	"fetchedAt changed"
);
//#endregion

//#region version metadata (fake CPA)
const fake = createFakeCpa();
// The upstream-release lookup is cached process-wide on purpose (it asks GitHub),
// so the fake suite must clear it or it would assert against the live answer.
resetLatestVersionCache();
const offline = await boot({ client: fake.client, config: fakeConfig });
const offlineServer = offline.get("webServer");
const offlineSnapshot = await call(offlineServer.routes.get(SNAPSHOT_PATH).handler, { path: SNAPSHOT_PATH });
const offlineBody = offlineSnapshot.json?.snapshot;
check("the snapshot carries the CPA build", offlineBody?.cpa?.version === "7.2.159" && offlineBody?.cpa?.commit === "ac02da6c", JSON.stringify(offlineBody?.cpa));
check("the newest release is compared to the build", offlineBody?.cpa?.latestVersion === "v7.3.7" && offlineBody?.cpa?.updateAvailable === true, JSON.stringify(offlineBody?.cpa));
check("accounts carry priority and note", offlineBody?.accounts?.[0]?.priority === 5 && offlineBody?.accounts?.[0]?.note === "primary", JSON.stringify(offlineBody?.accounts?.[0]?.priority));
check("a disabled account still reports its priority", offlineBody?.accounts?.[1]?.disabled === true && offlineBody?.accounts?.[1]?.priority === 0);
//#endregion

//#region credential writes (fake CPA)
const accountHandler = offlineServer.routes.get(ACCOUNT_PATH).handler;
const actionHeaders = { [composeActionHeader]: "write" };
check("the write route is registered", accountHandler !== undefined, ACCOUNT_PATH);

const readOnlyWrite = await call(accountHandler, { path: ACCOUNT_PATH, method: "GET" });
check("a GET on the write route is refused", readOnlyWrite.status === 405, `HTTP ${String(readOnlyWrite.status)}`);

const unheaderedWrite = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", body: JSON.stringify({ action: "status", authIndex: "fake-one", disabled: true }) });
check("a write without the action header is refused", unheaderedWrite.status === 400, `HTTP ${String(unheaderedWrite.status)}`);

const foreignWrite = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", peer: "10.0.0.7", headers: actionHeaders, body: "{}" });
check("a write from a non-loopback peer is refused", foreignWrite.status === 403, `HTTP ${String(foreignWrite.status)}`);

const disable = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", headers: actionHeaders, body: JSON.stringify({ action: "status", authIndex: "fake-one", disabled: true }) });
check("disabling an account succeeds", disable.status === 200 && disable.json?.ok === true, JSON.stringify(disable.json)?.slice(0, 160));
check(
	"the disable write addresses CPA by credential file name",
	fake.writes.some((write) => write.path.endsWith("/auth-files/status") && write.body.name === "codex-fake-one.json" && write.body.disabled === true),
	JSON.stringify(fake.writes)
);
check("the write response carries the refreshed snapshot", disable.json?.snapshot?.accounts?.length === 2, JSON.stringify(disable.json?.snapshot?.counts));

const edit = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", headers: actionHeaders, body: JSON.stringify({ action: "fields", authIndex: "fake-two", note: "backup", priority: 9 }) });
check("editing note and priority succeeds", edit.status === 200 && edit.json?.ok === true, JSON.stringify(edit.json)?.slice(0, 160));
check(
	"the edit write carries only the changed fields",
	fake.writes.some((write) => write.path.endsWith("/auth-files/fields") && write.body.name === "codex-fake-two.json" && write.body.note === "backup" && write.body.priority === 9),
	JSON.stringify(fake.writes)
);

const unknownAccount = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", headers: actionHeaders, body: JSON.stringify({ action: "status", authIndex: "nope", disabled: true }) });
check("an unknown authIndex is refused", unknownAccount.status === 400 && String(unknownAccount.json?.error).includes("unknown authIndex"), JSON.stringify(unknownAccount.json));

const badDisabled = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", headers: actionHeaders, body: JSON.stringify({ action: "status", authIndex: "fake-one", disabled: "yes" }) });
check("a non-boolean disabled is refused", badDisabled.status === 400 && String(badDisabled.json?.error).includes("boolean"), JSON.stringify(badDisabled.json));

const badAction = await call(accountHandler, { path: ACCOUNT_PATH, method: "POST", headers: actionHeaders, body: JSON.stringify({ action: "delete-everything", authIndex: "fake-one" }) });
check("an unknown action is refused", badAction.status === 400 && String(badAction.json?.error).includes("unknown action"), JSON.stringify(badAction.json));
check("no refused write reached CPA", fake.writes.length === 2, JSON.stringify(fake.writes.map((write) => write.path)));
//#endregion

//#region failed-request diagnostics
const diagnosticsHandler = offlineServer.routes.get(DIAGNOSTICS_PATH).handler;
const diagnosticsList = await call(diagnosticsHandler, { path: DIAGNOSTICS_PATH });
check("the diagnostics listing answers", diagnosticsList.status === 200 && diagnosticsList.json?.ok === true, `HTTP ${String(diagnosticsList.status)}`);
check("the listing parses endpoint and time from the file name", diagnosticsList.json?.files?.every((file) => file.name.endsWith(".log")) && diagnosticsList.json?.files?.[0]?.at !== null, JSON.stringify(diagnosticsList.json?.files?.[0]));
check("the listing reports the request-log flag", diagnosticsList.json?.requestLogEnabled === false, String(diagnosticsList.json?.requestLogEnabled));

const badMethod = await call(diagnosticsHandler, { path: DIAGNOSTICS_PATH, method: "POST" });
check("diagnostics refuse a write method", badMethod.status === 405, `HTTP ${String(badMethod.status)}`);

const traversing = await call(diagnosticsHandler, { path: `${DIAGNOSTICS_PATH}?file=${encodeURIComponent("../../etc/passwd")}` });
check("a path-traversing log name is refused", traversing.status === 400 && String(traversing.json?.error).includes("not an error-log name"), JSON.stringify(traversing.json));

const unlisted = await call(diagnosticsHandler, { path: `${DIAGNOSTICS_PATH}?file=${encodeURIComponent("error-v1-fake-2020-01-01T000000-deadbeef.log")}` });
check("a well-formed but unlisted log name is refused", unlisted.status === 400 && String(unlisted.json?.error).includes("not in the current listing"), JSON.stringify(unlisted.json));

const firstName = diagnosticsList.json.files[0].name;
const detail = await call(diagnosticsHandler, { path: `${DIAGNOSTICS_PATH}?file=${encodeURIComponent(firstName)}` });
check("reading one log answers", detail.status === 200 && detail.json?.log?.name === firstName, `HTTP ${String(detail.status)}`);
check("the log's upstream status is parsed", detail.json?.log?.status === 502, String(detail.json?.log?.status));
check("the log's error code and message are parsed", detail.json?.log?.errorCode === "server_is_overloaded" && typeof detail.json?.log?.errorMessage === "string", JSON.stringify({ code: detail.json?.log?.errorCode }));
check("the log's model and retry count are parsed", detail.json?.log?.model === "gpt-5.6-luna" && detail.json?.log?.attempts?.length === 2, JSON.stringify({ model: detail.json?.log?.model, attempts: detail.json?.log?.attempts?.length }));
check(
	"each attempt is attributed to the credential that served it",
	detail.json?.log?.attempts?.[0]?.authId === "codex-bbbb2222-bravo@example.com-free.json" &&
		detail.json?.log?.attempts?.[1]?.authId === "codex-aaaa1111-alpha@example.com-free.json",
	JSON.stringify(detail.json?.log?.attempts?.map((attempt) => attempt.authId))
);
check("the log carries its raw text", typeof detail.json?.log?.text === "string" && detail.json.log.text.includes("=== REQUEST INFO ==="));
//#endregion

//#region live failed-request diagnostics (read-only)
const liveDiagnostics = await call(app.get("webServer").routes.get(DIAGNOSTICS_PATH).handler, { path: DIAGNOSTICS_PATH });
if (liveDiagnostics.status === 200 && liveDiagnostics.json?.ok === true) {
	const files = liveDiagnostics.json.files ?? [];
	check("a live diagnostics listing parses", files.every((file) => typeof file.name === "string" && file.endpoint !== null), String(files.length));
	process.stdout.write(`  info   live diagnostics: ${String(files.length)} error log(s), request-log=${String(liveDiagnostics.json.requestLogEnabled)}\n`);
	if (files.length > 0) {
		const one = await call(app.get("webServer").routes.get(DIAGNOSTICS_PATH).handler, { path: `${DIAGNOSTICS_PATH}?file=${encodeURIComponent(files[0].name)}` });
		check("a live log parses into a summary", one.status === 200 && typeof one.json?.log?.name === "string", JSON.stringify(one.json)?.slice(0, 160));
		check("a live log is attributed to accounts", Array.isArray(one.json?.log?.accounts) && one.json.log.accounts.length > 0, JSON.stringify(one.json?.log?.accounts));
	}
} else {
	process.stdout.write(`  skip   live diagnostics unavailable (${String(liveDiagnostics.json?.error)?.slice(0, 90)})\n`);
}
//#endregion

//#region degradation without a settings service
const bare = await boot({ withSettings: false });
const bareServer = bare.get("webServer");
check("boots with no settings service at all", bareServer.routes.has(SNAPSHOT_PATH), bareServer.registered.join(", "));
const bareSnapshot = await call(bareServer.routes.get(SNAPSHOT_PATH).handler, { path: SNAPSHOT_PATH });
check(
	"composition config alone still serves a snapshot",
	bareSnapshot.status === 200 && bareSnapshot.json?.config?.baseURL === compositionConfig.baseURL,
	String(bareSnapshot.json?.config?.baseURL)
);
//#endregion

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
