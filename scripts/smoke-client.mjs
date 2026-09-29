#!/usr/bin/env node
/**
 * Render harness for the browser half.
 *
 * Proves the bundle is a well-formed `__ModuleLoader__` registration, that
 * `apply` wires the sidebar footer slot with the documented shape, and that the
 * panel renders a REAL captured snapshot (test/fixtures/snapshot.json) into a
 * jsdom document with React 18 — the same major the DSH web shell ships.
 *
 * React, react-dom, and jsdom come from this package's own `.test-env`
 * install, so the plugin package itself stays dependency-free.
 *
 *   node scripts/smoke-client.mjs
 */

import { readFileSync, existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const testEnv = join(packageDir, ".test-env");
const require = createRequire(join(testEnv, "package.json"));

const checks = [];
/**
 * Record one assertion.
 * @param label - what was checked.
 * @param condition - the assertion result.
 * @param detail - optional context printed on failure.
 */
function check(label, condition, detail) {
	checks.push({ label, ok: Boolean(condition), detail });
	if (!condition) process.stdout.write(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}\n`);
}

/**
 * A stand-in for one bound settings namespace scope.
 *
 * Mirrors the documented `SettingsScope` contract closely enough to drive the
 * card: a snapshot that is replaced (never mutated) on every change, a
 * subscribe/notify pair, and revision-fenced `set`/`unset` writes that record
 * what the card asked for.
 *
 * @param options - the initial resolved section and user layer.
 * @returns the scope plus the ordered write log.
 */
function createScopeStub(options = {}) {
	let revision = 1;
	let snapshot = {
		status: options.status ?? "ready",
		value: options.value,
		base: options.base ?? options.value,
		user: options.user,
		revision,
		writable: options.writable ?? true,
		mode: "host"
	};
	const listeners = new Set();
	const writes = [];
	const publish = (next) => {
		revision += 1;
		snapshot = { ...next, revision };
		for (const listener of [...listeners]) listener();
	};
	return {
		writes,
		scope: {
			getSnapshot: () => snapshot,
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async set(field, value) {
				writes.push({ op: "set", field, value });
				const user = { ...(snapshot.user ?? {}), [field]: value };
				publish({ ...snapshot, value: { ...snapshot.value, [field]: value }, user });
			},
			async unset(field) {
				writes.push({ op: "unset", field });
				const value = { ...snapshot.value };
				delete value[field];
				const user = { ...(snapshot.user ?? {}) };
				delete user[field];
				publish({ ...snapshot, value, user: Object.keys(user).length === 0 ? undefined : user });
			},
			async mutate(ops) {
				writes.push({ op: "mutate", ops });
			}
		}
	};
}

//#region environment
if (!existsSync(join(testEnv, "node_modules", "react"))) {
	process.stderr.write(`smoke-client: missing render harness at ${testEnv}\nrun: (cd .test-env && npm --cache ../.npm-cache install react@18 react-dom@18 jsdom)\n`);
	process.exit(2);
}

const react = require("react");
const reactDomClient = require("react-dom/client");
const { JSDOM } = require("jsdom");
const act = react.act ?? require("react-dom/test-utils").act;
// `Simulate` is the only reliable way to drive a controlled React input here:
// dispatching a native `input` event reaches `onInput` but never the synthetic
// `onChange` the card uses, because React's value tracker reads its own snapshot.
const Simulate = require("react-dom/test-utils").Simulate;

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
	url: "http://127.0.0.1:3080/",
	pretendToBeVisual: true
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// Node exposes `navigator` as a getter-only global, so redefine instead of assigning.
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
//#endregion

//#region bundle registration
const snapshot = JSON.parse(readFileSync(join(packageDir, "test", "fixtures", "snapshot.json"), "utf8"));
const errorLogList = JSON.parse(readFileSync(join(packageDir, "test", "fixtures", "error-logs.json"), "utf8"));
const errorLogParsed = JSON.parse(readFileSync(join(packageDir, "test", "fixtures", "error-log-parsed.json"), "utf8"));
const refreshed = { ...snapshot, fetchedAt: Date.now(), durationMs: 4321, proxy: "http://127.0.0.1:1080" };
const requests = [];

/**
 * Stand-in fetch: dispatches on the route, records every request, and folds a
 * credential write back into the snapshot it returns — so the panel's read-back
 * path is exercised rather than assumed.
 */
window.fetch = (url, init) => {
	const target = String(url);
	const method = (init && init.method) || "GET";
	const headers = (init && init.headers) || {};
	requests.push({ url: target, method, headers, body: init && init.body });
	const reply = (payload) => Promise.resolve({ status: 200, json: () => Promise.resolve(payload) });
	const envelope = (body) => ({ ok: true, snapshot: body, error: null, ageMs: 1000, intervalMs: 300000, capabilities: ["account", "diagnostics", "cpa"] });

	if (target.startsWith("/api/cpa-monitor/account")) {
		const patch = JSON.parse(init.body);
		const next = {
			...snapshot,
			accounts: snapshot.accounts.map((account) => {
				if (account.authIndex !== patch.authIndex) return account;
				if (patch.action === "status") return { ...account, disabled: patch.disabled };
				return { ...account, note: patch.note ?? account.note, priority: patch.priority ?? account.priority };
			})
		};
		return reply(envelope(next));
	}
	if (target.startsWith("/api/cpa-monitor/diagnostics")) {
		if (target.includes("?file=")) return reply({ ok: true, log: errorLogParsed });
		return reply({ ok: true, ...errorLogList });
	}
	return reply(envelope(target.includes("refresh") ? refreshed : snapshot));
};

const primitives = {
	Tag: (props) => react.createElement("span", { "data-tag": props.tone, className: props.className }, props.children),
	IconGaugeOutline16: (props) => react.createElement("span", { "data-icon": "gauge", ...props }),
	IconRefreshOutline16: (props) => react.createElement("span", { "data-icon": "refresh", ...props }),
	IconCloseOutline16: (props) => react.createElement("span", { "data-icon": "close", ...props })
};
const moduleTable = {
	react,
	"react-dom": require("react-dom"),
	"@deepseek-ai/dsh-client-ui-primitives": primitives
};

let registration;
// Run the bundle in the NODE realm with the jsdom `window`/`document`/`fetch`
// injected. Evaluating it inside the jsdom realm instead would put its promise
// chain on jsdom's microtask queue, where React's `act` cannot flush it — dead
// giveaway: every setState lands as "not wrapped in act" and act itself hangs.
const bundleSource = readFileSync(join(packageDir, "lib", "client.js"), "utf8");
const sandboxWindow = {
	__ModuleLoader__: {
		load(value) {
			registration = value;
		}
	},
	getComputedStyle: window.getComputedStyle.bind(window)
};
// Forward, don't capture: the bundle takes `fetch` as a parameter, so handing it
// window.fetch's current value would freeze the stub at construction time and
// silently ignore any later swap.
new Function("window", "document", "fetch", bundleSource)(sandboxWindow, window.document, (...args) => window.fetch(...args));

check("bundle registers through __ModuleLoader__.load", registration !== undefined);
check("registration id matches the package name", registration?.id === "dsh-cpa-monitor", String(registration?.id));
check("registration exposes a factory", typeof registration?.factory === "function");
const exports = registration.factory((specifier) => {
	if (specifier in moduleTable) return moduleTable[specifier];
	throw new Error(`unexpected require("${specifier}")`);
});
check("factory returns the module face", typeof exports?.apply === "function" && typeof exports?.inject === "object");
check(
	"client inject list keeps the settings client optional",
	JSON.stringify(exports.inject) === JSON.stringify(["slots", "locale"]),
	JSON.stringify(exports.inject)
);
//#endregion

//#region apply() wiring
const registrations = [];
const dictionaries = [];
const injected = [];
const boundNamespaces = [];
const scopeStub = createScopeStub({
	value: {
		baseURL: "https://cpa.example.com:8317",
		managementKey: "",
		proxies: ["http://127.0.0.1:1081", "http://127.0.0.1:1080"],
		allowDirect: false,
		providerFilter: "codex",
		includeDisabled: true,
		badgeMode: "lowest",
		refreshIntervalMs: 300000,
		timeoutMs: 20000,
		connectTimeoutMs: 10000,
		timeZone: "Asia/Shanghai",
		insecure: false
	},
	user: { refreshIntervalMs: 300000 }
});
const fakeCtx = {
	inject(names, callback) {
		injected.push(...names);
		if (names.includes("settingsScope")) callback(fakeCtx);
	},
	settingsScope: {
		bind(spec) {
			boundNamespaces.push(spec.namespace);
			return scopeStub.scope;
		}
	},
	effect(fn) {
		fn();
	},
	locale: {
		register(namespace, value) {
			dictionaries.push({ namespace, value });
		}
	},
	slots: {
		inject(name, resolve) {
			injected.push(name);
			resolve();
		},
		register(options, component) {
			registrations.push({ options, component });
		}
	}
};
exports.apply(fakeCtx);
check(
	"apply injects into the sidebar footer slot and the settings service",
	["sidebar.footer.action", "settingsScope", "settings.plugin.item"].every((name) => injected.includes(name)),
	JSON.stringify(injected)
);
check("apply registers exactly two occupants", registrations.length === 2, String(registrations.length));
check(
	"occupant registration shape",
	registrations[0]?.options?.name === "sidebar.footer.action" &&
		registrations[0]?.options?.id === "cpa-monitor" &&
		registrations[0]?.options?.locale === "cpa-monitor" &&
		registrations[0]?.options?.order === 20,
	JSON.stringify(registrations[0]?.options)
);
check("registered component is the panel", registrations[0]?.component === exports.CpaStatusPanel);
const settingsRegistration = registrations.find((entry) => entry.options.name === "settings.plugin.item");
check("registers a settings card keyed by the namespace", settingsRegistration?.options.key === "cpa-monitor", JSON.stringify(settingsRegistration?.options));
check("settings card is the settings component", settingsRegistration?.component === exports.CpaSettingsCard);
check("binds the settings scope for its namespace", JSON.stringify(boundNamespaces) === JSON.stringify(["cpa-monitor"]), JSON.stringify(boundNamespaces));
check(
	"the settings service is injected optionally, not as an activation gate",
	!exports.inject.includes("settingsScope") && injected.includes("settingsScope"),
	`inject=${JSON.stringify(exports.inject)} optional=${JSON.stringify(injected)}`
);
check("dictionaries registered under the same namespace", dictionaries[0]?.namespace === "cpa-monitor" && dictionaries[0]?.value?.zh && dictionaries[0]?.value?.en);
check(
	"zh/en dictionaries have identical key sets",
	JSON.stringify(Object.keys(exports.zh).sort()) === JSON.stringify(Object.keys(exports.en).sort()),
	JSON.stringify(Object.keys(exports.zh).filter((key) => !(key in exports.en)))
);
//#endregion

//#region pure helpers
check("durationText minutes", exports.durationText(600) === "10m", exports.durationText(600));
check("durationText hours", exports.durationText(9060) === "2h31m", exports.durationText(9060));
check("durationText days", exports.durationText(200000) === "2d8h", exports.durationText(200000));
check("toneOfRemaining ok", exports.toneOfRemaining(80) === "ok");
check("toneOfRemaining warn", exports.toneOfRemaining(20) === "warn");
check("toneOfRemaining bad", exports.toneOfRemaining(4) === "bad");
check("toneOfRemaining unknown", exports.toneOfRemaining(null) === "muted");
check(
	"resetText joins stamp and localized countdown",
	exports.resetText({ resetAt: Math.floor(Date.now() / 1000) + 3600, resetText: "09/18 03:34" }, Date.now(), "left").includes("left") &&
		exports.resetText({ resetAt: null, resetText: "09/18 03:34" }, Date.now(), "left") === "09/18 03:34"
);
/**
 * Build one account for the badge-rule checks. `windows` lists `[label, remaining]`
 * pairs in short-then-long order; the badge reads `short`/`long` off the account,
 * exactly as the server half's snapshot carries them.
 */
function accountFixture(email, windows, extra = {}) {
	const parsed = windows.map(([label, remaining]) => ({ label, remaining, resetText: "—", resetAt: null }));
	return {
		authIndex: email,
		email,
		disabled: false,
		windows: parsed,
		short: parsed.find((window) => window.label === "5h") ?? null,
		long: parsed.find((window) => window.label !== "5h") ?? null,
		...extra
	};
}
/** The chosen account and the rule that chose it. */
const badgeOf = (accounts) => {
	const picked = exports.pickBadge({ accounts });
	return picked === null ? null : `${picked.account.email}:${picked.reason}`;
};

check("no accounts means no badge value", exports.pickBadge({ accounts: [] }) === null);
check("no account with a numeric window means no badge value", exports.pickBadge({ accounts: [accountFixture("a", [])] }) === null);
check(
	"a short window under 20% wins outright",
	badgeOf([accountFixture("a", [["5h", 15], ["7d", 80]]), accountFixture("b", [["5h", 90], ["7d", 5]])]) === "a:short",
	badgeOf([accountFixture("a", [["5h", 15], ["7d", 80]]), accountFixture("b", [["5h", 90], ["7d", 5]])])
);
check(
	"the tightest urgent short window wins, not the first one",
	badgeOf([accountFixture("a", [["5h", 12], ["7d", 60]]), accountFixture("b", [["5h", 8], ["7d", 90]])]) === "b:short",
	badgeOf([accountFixture("a", [["5h", 12], ["7d", 60]]), accountFixture("b", [["5h", 8], ["7d", 90]])])
);
check(
	"exactly 20% is not urgent, so the long window decides",
	badgeOf([accountFixture("a", [["5h", 20], ["7d", 44]])]) === "a:long",
	badgeOf([accountFixture("a", [["5h", 20], ["7d", 44]])])
);
check(
	"all comfortable short windows fall through to the tightest long one",
	badgeOf([accountFixture("a", [["5h", 92], ["7d", 18]]), accountFixture("b", [["5h", 55], ["7d", 9]])]) === "b:long",
	badgeOf([accountFixture("a", [["5h", 92], ["7d", 18]]), accountFixture("b", [["5h", 55], ["7d", 9]])])
);
check(
	"a disabled account never sets the badge",
	badgeOf([accountFixture("off", [["5h", 1], ["7d", 1]], { disabled: true }), accountFixture("on", [["5h", 70], ["7d", 40]])]) === "on:long",
	badgeOf([accountFixture("off", [["5h", 1], ["7d", 1]], { disabled: true }), accountFixture("on", [["5h", 70], ["7d", 40]])])
);
check(
	"short-only fleets fall back to the tightest short window",
	badgeOf([accountFixture("a", [["5h", 80]]), accountFixture("b", [["5h", 45]])]) === "b:fallback",
	badgeOf([accountFixture("a", [["5h", 80]]), accountFixture("b", [["5h", 45]])])
);
check(
	"a 30d-only account participates as a long window",
	badgeOf([accountFixture("free", [["30d", 12]])]) === "free:long",
	badgeOf([accountFixture("free", [["30d", 12]])])
);
const form = (values) => exports.remainingText(values);
check("the value is the 5h/7d pair when nothing reports 30d", form({ "5h": 100, "7d": 9, "30d": null }) === "100%/9%", form({ "5h": 100, "7d": 9, "30d": null }));
check("a 30d window extends the format to three segments", form({ "5h": 100, "7d": 9, "30d": 65 }) === "100%/9%/65%", form({ "5h": 100, "7d": 9, "30d": 65 }));
check("fractions round to whole percents", form({ "5h": 99.6, "7d": 8.4, "30d": null }) === "100%/8%", form({ "5h": 99.6, "7d": 8.4, "30d": null }));
check("a missing 5h or 7d renders as a dash", form({ "5h": null, "7d": null, "30d": 65 }) === "-/-/65%", form({ "5h": null, "7d": null, "30d": 65 }));
check("a missing 7d alone still shows the 30d segment", form({ "5h": 100, "7d": null, "30d": 12 }) === "100%/-/12%", form({ "5h": 100, "7d": null, "30d": 12 }));
check("no values at all is all dashes", form({ "5h": null, "7d": null, "30d": null }) === "-/-", form({ "5h": null, "7d": null, "30d": null }));

// sums: one window per account, disabled accounts contribute nothing
const pooled = [
	accountFixture("a", [["5h", 100], ["7d", 9], ["30d", 65]]),
	accountFixture("b", [["5h", 33], ["7d", 89]]),
	accountFixture("off", [["5h", 1], ["7d", 1], ["30d", 1]], { disabled: true })
];
check("a window sums across enabled accounts", exports.sumRemaining(pooled, "5h") === 133, String(exports.sumRemaining(pooled, "5h")));
check("a window nothing reports sums to null", exports.sumRemaining([accountFixture("b", [["5h", 33]])], "30d") === null, String(exports.sumRemaining([accountFixture("b", [["5h", 33]])], "30d")));
check("disabled accounts add no headroom", exports.sumRemaining(pooled, "30d") === 65, String(exports.sumRemaining(pooled, "30d")));
check(
	"total mode reads every window as a sum",
	exports.remainingText(exports.badgeValues({ accounts: pooled }, "total")) === "133%/98%/65%",
	exports.remainingText(exports.badgeValues({ accounts: pooled }, "total"))
);
check(
	"lowest mode reads the picked account's own windows",
	exports.remainingText(exports.badgeValues({ accounts: pooled }, "lowest")) === "100%/9%/65%",
	exports.remainingText(exports.badgeValues({ accounts: pooled }, "lowest"))
);

const layerEl = window.document.createElement("div");
const panelEl = window.document.createElement("div");
check("shouldDismissPanel outside", exports.shouldDismissPanel([], window.document.body, layerEl, panelEl) === true);
check("shouldDismissPanel inside layer", exports.shouldDismissPanel([layerEl], null, layerEl, panelEl) === false);
check("worstOf flags a fetch error", exports.worstOf({ disabled: false, error: "boom", minRemaining: 80 }) === "bad");
check("worstOf flags a nearly exhausted window", exports.worstOf({ disabled: false, error: null, minRemaining: 3, limitReached: false }) === "bad");
check("worstOf flags an exhausted limit", exports.worstOf({ disabled: false, error: null, minRemaining: 50, limitReached: true }) === "bad");
check("worstOf ignores disabled accounts", exports.worstOf({ disabled: true, minRemaining: 1 }) === null);
//#endregion

//#region render against the captured snapshot
const container = window.document.getElementById("root");
const root = reactDomClient.createRoot(container);
const expectedPick = exports.pickBadge(snapshot);
const fixtureBadgeMode = snapshot.config?.badgeMode === "total" ? "total" : "lowest";
const expectedBadge = exports.remainingText(exports.badgeValues(snapshot, fixtureBadgeMode));
const busiest = [...snapshot.accounts].sort((left, right) => right.success - left.success)[0];

await act(async () => {
	root.render(react.createElement(exports.CpaStatusPanel, { wide: true, t: undefined }));
	await Promise.resolve();
});
await act(async () => {
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});

const badgeButton = container.querySelector(".cps_badge");
check("badge renders", badgeButton !== null);
check("badge shows the window figures the mode picks", container.textContent.includes(expectedBadge), container.textContent.slice(0, 200));
check(
	"badge tooltip names the account behind the figures",
	(container.querySelector(".cps_badge")?.getAttribute("title") ?? "").includes(expectedPick.account.email),
	container.querySelector(".cps_badge")?.getAttribute("title")
);
check(
	"badge tooltip names the account the value came from",
	(container.querySelector(".cps_badge")?.getAttribute("title") ?? "").includes(expectedPick.account.email),
	container.querySelector(".cps_badge")?.getAttribute("title")
);
check("badge shows the account count", container.textContent.includes(`${String(snapshot.counts.active)}/${String(snapshot.counts.total)}`));
const expectedTone = exports.toneOfRemaining(
	Math.min(...[expectedPick.account.short?.remaining, expectedPick.account.long?.remaining].filter((entry) => typeof entry === "number"))
);
check(
	"badge value carries the tone class",
	container.querySelector(`.cps_badgeAmount.cps_${expectedTone}`) !== null,
	`expected cps_${expectedTone} in ${container.querySelector(".cps_badgeAmount")?.className ?? "<none>"}`
);
check("no error state while the fixture loads", container.textContent.includes("CPA") && !container.textContent.includes("无法连接"));
check(
	"the sidebar row leads with an outline icon like its neighbours",
	container.querySelector('.cps_iconWrap [data-icon="gauge"]') !== null,
	container.innerHTML.slice(0, 200)
);
check("the wide badge keeps no separate status dot", container.querySelector(".cps_dot") === null, container.innerHTML.slice(0, 200));
check("snapshot fetch went to the snapshot route", requests.some((entry) => entry.url === "/api/cpa-monitor/snapshot"), JSON.stringify(requests));

// Open the panel; it is portaled to document.body.
await act(async () => {
	badgeButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
const panel = window.document.body.querySelector("[data-cpa-status-panel]");
check("panel portals to document.body", panel !== null);
const panelText = panel?.textContent ?? "";
for (const account of snapshot.accounts) {
	check(`panel lists ${account.email}`, panelText.includes(account.email), account.email);
}
check("panel lists every rate-limit window label", snapshot.accounts.every((account) => account.windows.every((window) => panelText.includes(window.label))));
check("panel renders one card per account", window.document.body.querySelectorAll(".cps_card").length === snapshot.accounts.length, String(window.document.body.querySelectorAll(".cps_card").length));
check("panel renders progress bars", window.document.body.querySelectorAll(".cps_fill").length >= snapshot.accounts.reduce((total, account) => total + account.windows.length, 0));
check("panel renders request sparklines", window.document.body.querySelectorAll(".cps_spark").length >= 1);
check("panel shows upstream health counters", panelText.includes(String(busiest.success)), String(busiest.success));
check("panel headline repeats the figures", panelText.includes(expectedBadge), expectedBadge);
check("panel headline names the mode", panelText.includes("用量最低"), panelText.slice(0, 160));
check(
	"panel headline tooltip names the account",
	(window.document.body.querySelector(".cps_summaryValue")?.getAttribute("title") ?? "").includes(expectedPick.account.email),
	window.document.body.querySelector(".cps_summaryValue")?.getAttribute("title")
);
const subtitleText = panel?.querySelector(".cps_subtitle")?.textContent ?? "";
check("the subtitle carries the CPA address", subtitleText.includes(snapshot.baseURL), subtitleText);
check("the subtitle does not carry the proxy", !subtitleText.includes(snapshot.proxy), subtitleText);
const footnoteText = panel?.querySelector(".cps_note")?.textContent ?? "";
check("the footnote is the quota note alone", footnoteText.includes("剩余百分比") && !footnoteText.includes("当前传输"), footnoteText);
check("the footnote names neither the CPA address nor the proxy", !footnoteText.includes(snapshot.baseURL) && !footnoteText.includes(snapshot.proxy), footnoteText);
check("the footnote no longer points at the settings page", !footnoteText.includes("设置 → 插件"), footnoteText);
const failedAccount = snapshot.accounts.find((account) => typeof account.error === "string" && account.error !== "");
check(
	"panel surfaces a per-account failure verbatim",
	failedAccount === undefined || panelText.includes(failedAccount.error.slice(0, 40)),
	failedAccount?.error
);

// Manual refresh must carry the action header the server half requires.
const refreshButton = [...window.document.body.querySelectorAll(".cps_iconButton")].find((node) => node.getAttribute("title") === "刷新");
check("refresh button renders", refreshButton !== undefined);
await act(async () => {
	refreshButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
const refreshCall = requests.find((entry) => entry.url === "/api/cpa-monitor/refresh");
check("refresh hits the refresh route", refreshCall !== undefined);
check(
	"refresh carries the action header",
	refreshCall !== undefined && Object.keys(refreshCall.headers).some((key) => key.toLowerCase() === "x-dsh-cpa-monitor-action"),
	JSON.stringify(refreshCall?.headers)
);

//#region version chip
check("the panel shows the running CPA build", panelText.includes(`CPA ${snapshot.cpa.version}`), panelText.slice(0, 200));
check(
	"the panel flags a newer release",
	panelText.includes(snapshot.cpa.latestVersion) && (window.document.body.querySelector(".cps_warn")?.textContent ?? "").includes(snapshot.cpa.latestVersion),
	snapshot.cpa.latestVersion
);
//#endregion

//#region total mode
const lowestText = exports.remainingText(exports.badgeValues(snapshot, "lowest"));
const totalText = exports.remainingText(exports.badgeValues(snapshot, "total"));
check("the fixture distinguishes the two modes", lowestText !== totalText, `${lowestText} vs ${totalText}`);

const totalFetch = window.fetch;
window.fetch = (url, init) => {
	const target = String(url);
	if (target.startsWith("/api/cpa-monitor/account")) return totalFetch(url, init);
	return Promise.resolve({
		status: 200,
		json: () =>
			Promise.resolve({
				ok: true,
				snapshot,
				error: null,
				ageMs: 1000,
				intervalMs: 300000,
				capabilities: ["account", "diagnostics", "cpa"],
				config: { badgeMode: "total" }
			})
	});
};
const totalContainer = window.document.createElement("div");
window.document.body.appendChild(totalContainer);
const totalRoot = reactDomClient.createRoot(totalContainer);
await act(async () => {
	totalRoot.render(react.createElement(exports.CpaStatusPanel, { wide: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
const totalBadge = totalContainer.querySelector(".cps_badge");
check("total mode renders the summed figures", totalBadge?.textContent.includes(totalText), `expected ${totalText} in ${totalBadge?.textContent ?? ""}`);
check("total mode does not fall back to the single account", !totalBadge?.textContent.includes(lowestText), totalBadge?.textContent ?? "");
check(
	"total mode tooltip says it is a sum",
	(totalBadge?.getAttribute("title") ?? "").includes("累加"),
	totalBadge?.getAttribute("title") ?? ""
);
await act(async () => {
	totalRoot.unmount();
});
window.fetch = totalFetch;
//#endregion

//#region tone follows the displayed figure, not the worst account
/** Render the panel over one crafted payload and report the badge's tone class. */
const toneFor = async (mode, accounts) => {
	const previous = window.fetch;
	window.fetch = () =>
		Promise.resolve({
			status: 200,
			json: () =>
				Promise.resolve({
					ok: true,
					snapshot: {
						ok: true,
						source: "cpa",
						baseURL: "https://cpa.example.com:8317",
						proxy: "direct",
						transport: [],
						fetchedAt: Date.now(),
						durationMs: 1,
						accounts,
						counts: {
							total: accounts.length,
							active: accounts.filter((account) => account.disabled !== true).length,
							error: 0,
							disabled: 0
						},
						minRemaining: 0,
						attention: 0,
						errors: [],
						providerFilter: "codex",
						cpa: { version: "9.9.9", commit: null, buildDate: null, latestVersion: null, updateAvailable: false }
					},
					error: null,
					ageMs: 1,
					intervalMs: 300000,
					capabilities: ["account", "diagnostics", "cpa"],
					config: { badgeMode: mode }
				})
		});
	const holder = window.document.createElement("div");
	window.document.body.appendChild(holder);
	const root = reactDomClient.createRoot(holder);
	await act(async () => {
		root.render(react.createElement(exports.CpaStatusPanel, { wide: true }));
		await Promise.resolve();
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const classes = holder.querySelector(".cps_badgeAmount")?.className ?? "";
	await act(async () => {
		root.unmount();
	});
	window.fetch = previous;
	return classes;
};

// A pool where one account is spent and the other is full: the aggregate is fine,
// and because a pool load-balances, that must not read as an alert.
const mixedPool = [
	accountFixture("spent@example.com", [["5h", 100], ["7d", 0]]),
	accountFixture("fresh@example.com", [["5h", 100], ["7d", 100]])
];
const totalTone = await toneFor("total", mixedPool);
check("a healthy pool stays green even with one exhausted account", totalTone.includes("cps_ok"), totalTone);
const lowestTone = await toneFor("lowest", mixedPool);
check("lowest mode still warns, because it shows that account", lowestTone.includes("cps_bad"), lowestTone);
// And an actually empty pool still alerts in total mode.
const drainedTone = await toneFor("total", [accountFixture("a", [["5h", 4], ["7d", 2]]), accountFixture("b", [["5h", 3], ["7d", 1]])]);
check("a drained pool does alert in total mode", drainedTone.includes("cps_bad"), drainedTone);
//#endregion

//#region credential writes
const cardOf = (email) => [...window.document.body.querySelectorAll(".cps_card")].find((node) => node.textContent.includes(email));
const cardButton = (card, label) => [...card.querySelectorAll("button")].find((node) => node.textContent === label);
const enabledCard = cardOf(snapshot.accounts[0].email);
const disabledCard = cardOf(snapshot.accounts[2].email);
check("an enabled account offers 禁用", cardButton(enabledCard, "禁用") !== undefined, enabledCard?.textContent?.slice(0, 120));
check("a disabled account offers 启用", cardButton(disabledCard, "启用") !== undefined, disabledCard?.textContent?.slice(0, 120));
check("the card shows the credential priority", enabledCard.textContent.includes(`优先级 ${String(snapshot.accounts[0].priority)}`), String(snapshot.accounts[0].priority));

const beforeToggle = requests.length;
await act(async () => {
	cardButton(enabledCard, "禁用").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
const toggleRequest = requests.slice(beforeToggle).find((entry) => entry.url.startsWith("/api/cpa-monitor/account"));
check("the toggle posts to the credential route", toggleRequest?.method === "POST", JSON.stringify(toggleRequest?.method));
check(
	"the toggle carries the action header",
	Object.keys(toggleRequest?.headers ?? {}).some((key) => key.toLowerCase() === "x-dsh-cpa-monitor-action"),
	JSON.stringify(toggleRequest?.headers)
);
check(
	"the toggle addresses the account by authIndex, not by file name",
	JSON.parse(toggleRequest?.body ?? "{}").authIndex === snapshot.accounts[0].authIndex &&
		JSON.parse(toggleRequest?.body ?? "{}").action === "status" &&
		JSON.parse(toggleRequest?.body ?? "{}").disabled === true &&
		!JSON.stringify(JSON.parse(toggleRequest?.body ?? "{}")).includes(snapshot.accounts[0].name),
	JSON.stringify(toggleRequest?.body)
);
check("the panel folds the write result back in", cardButton(cardOf(snapshot.accounts[0].email), "启用") !== undefined, "card did not switch to 启用");

// Note / priority editing stages then saves.
await act(async () => {
	cardButton(cardOf(snapshot.accounts[0].email), "编辑").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
const editor = cardOf(snapshot.accounts[0].email).querySelector(".cps_cardEditor");
check("the editor discloses note and priority", editor !== null && editor.textContent.includes("备注") && editor.textContent.includes("优先级"), editor?.textContent?.slice(0, 120));
const editorInputs = [...editor.querySelectorAll("input")];
const beforeEdit = requests.length;
await act(async () => {
	Simulate.change(editorInputs[0], { target: { value: "backup account" } });
	Simulate.change(editorInputs[1], { target: { value: "9" } });
	await Promise.resolve();
});
await act(async () => {
	cardButton(cardOf(snapshot.accounts[0].email), "保存").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
const fieldRequest = requests.slice(beforeEdit).find((entry) => entry.url.startsWith("/api/cpa-monitor/account"));
const fieldBody = JSON.parse(fieldRequest?.body ?? "{}");
check(
	"the editor writes note and priority through the same route",
	fieldBody.action === "fields" && fieldBody.note === "backup account" && fieldBody.priority === 9,
	JSON.stringify(fieldBody)
);
//#endregion

//#region failed-request diagnostics
const diagnosticsSection = [...window.document.body.querySelectorAll(".cps_section")].pop();
check("the panel has a failures section", diagnosticsSection !== undefined && diagnosticsSection.textContent.includes("最近失败请求"), diagnosticsSection?.textContent?.slice(0, 80));
check("the failures section starts collapsed", diagnosticsSection.querySelector(".cps_diagRow") === null);

const beforeDiagnostics = requests.length;
await act(async () => {
	[...diagnosticsSection.querySelectorAll("button")].find((node) => node.textContent === "查看").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
const listRequest = requests.slice(beforeDiagnostics).find((entry) => entry.url.startsWith("/api/cpa-monitor/diagnostics"));
check("opening the section lists the logs", listRequest?.url === "/api/cpa-monitor/diagnostics", JSON.stringify(listRequest?.url));
const rows = [...diagnosticsSection.querySelectorAll(".cps_diagRow")];
check("one row per failed request", rows.length === errorLogList.files.length, `${String(rows.length)} vs ${String(errorLogList.files.length)}`);
check("a row names the endpoint and the size", rows[0].textContent.includes(errorLogList.files[0].endpoint) && rows[0].textContent.includes("KB"), rows[0].textContent);

const beforeDetail = requests.length;
await act(async () => {
	[...rows[0].querySelectorAll("button")].find((node) => node.textContent === "查看原文").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
const detailRequest = requests.slice(beforeDetail).find((entry) => entry.url.includes("?file="));
check("opening one log requests it by name", detailRequest?.url.includes(encodeURIComponent(errorLogList.files[0].name)), JSON.stringify(detailRequest?.url));
const sectionText = diagnosticsSection.textContent;
check("the detail shows the upstream status", sectionText.includes(`HTTP ${String(errorLogParsed.status)}`), String(errorLogParsed.status));
check("the detail shows the error message", sectionText.includes(errorLogParsed.errorMessage), errorLogParsed.errorMessage);
check("the detail shows the model and the retry count", sectionText.includes(errorLogParsed.model) && sectionText.includes("2 次尝试"), errorLogParsed.model);
check(
	"the detail attributes the failure to the accounts involved",
	errorLogParsed.accounts.every((account) => sectionText.includes(account.label)),
	sectionText.slice(0, 200)
);
check("the raw log is available", diagnosticsSection.querySelector(".cps_diagText")?.textContent.includes("=== REQUEST INFO ==="));
//#endregion

//#region a server half older than the capability contract
const legacyEnvelope = { ok: true, snapshot, error: null, ageMs: 1000, intervalMs: 300000 };
const legacyFetch = window.fetch;
window.fetch = (url, init) => {
	const target = String(url);
	if (target.startsWith("/api/cpa-monitor/account")) return legacyFetch(url, init);
	return Promise.resolve({ status: 200, json: () => Promise.resolve(legacyEnvelope) });
};
// Take the main panel down first: both panels portal into document.body, and
// portal order is not something to depend on when picking the one under test.
await act(async () => {
	root.unmount();
});
const legacyContainer = window.document.createElement("div");
window.document.body.appendChild(legacyContainer);
const legacyRoot = reactDomClient.createRoot(legacyContainer);
await act(async () => {
	legacyRoot.render(react.createElement(exports.CpaStatusPanel, { wide: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
// The panel opens on a badge click, so the stale-server notice lives one click in.
await act(async () => {
	legacyContainer.querySelector(".cps_badge").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 20));
});
// The panel ports to document.body, so read the newest portal rather than the layer.
const legacyPortals = [...window.document.body.querySelectorAll("[data-cpa-status-panel]")];
check("exactly the panel under test is open", legacyPortals.length === 1, String(legacyPortals.length));
const legacyPanel = legacyPortals[0];
const legacyPanelText = legacyPanel?.textContent ?? "";
check("a stale server is called out, not silently tolerated", legacyPanelText.includes("服务端 half 是旧版"), legacyPanelText.slice(0, 140));
// Count the controls rather than the copy: a card's status chip reads 已禁用, which
// contains the same two characters as the 禁用 button.
check("a stale server hides the credential controls", legacyPanel?.querySelectorAll(".cps_cardAction").length === 0, String(legacyPanel?.querySelectorAll(".cps_cardAction").length));
check("a stale server hides the editor too", legacyPanel?.querySelectorAll(".cps_cardEditor").length === 0);
check("a stale server hides the diagnostics section", legacyPanel?.querySelectorAll(".cps_section").length === 0);
check("a stale server shows no version chip", !legacyPanelText.includes("CPA 7.2.159") && !legacyPanelText.includes("版本未知"), "version chip rendered anyway");
await act(async () => {
	legacyRoot.unmount();
});
window.fetch = legacyFetch;
//#endregion

//#region priority drafts survive a server that reports none
check("a numeric priority becomes draft text", exports.priorityTextOf({ priority: 5 }) === "5");
check("a missing priority drafts blank, not the word undefined", exports.priorityTextOf({}) === "" && exports.priorityTextOf({ priority: null }) === "", JSON.stringify(exports.priorityTextOf({})));
check("a non-numeric priority drafts blank too", exports.priorityTextOf({ priority: "5" }) === "" && exports.priorityTextOf({ priority: Number.NaN }) === "");
//#endregion

// Rail mode (collapsed sidebar).
const railContainer = window.document.createElement("div");
window.document.body.appendChild(railContainer);
const railRoot = reactDomClient.createRoot(railContainer);
await act(async () => {
	railRoot.render(react.createElement(exports.CpaStatusPanel, { wide: false, t: undefined }));
	await Promise.resolve();
});
await act(async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
});
check("rail mode switches the layer class", railContainer.querySelector(".cps_rail") !== null, railContainer.innerHTML.slice(0, 160));
check("rail mode hides the text label", !railContainer.textContent.includes("CPA 账号"));
await act(async () => {
	railRoot.unmount();
});
//#endregion

//#region settings card
check("settings card renders nothing for an unavailable namespace", (() => {
	const probe = createScopeStub({ status: "unavailable", value: {} });
	const holder = window.document.createElement("div");
	window.document.body.appendChild(holder);
	const probeRoot = reactDomClient.createRoot(holder);
	let rendered;
	act(() => {
		probeRoot.render(react.createElement(exports.CpaSettingsCard, { scope: probe.scope, t: undefined }));
	});
	rendered = holder.innerHTML;
	act(() => {
		probeRoot.unmount();
	});
	return rendered === "";
})());

const cardContainer = window.document.createElement("div");
window.document.body.appendChild(cardContainer);
const cardRoot = reactDomClient.createRoot(cardContainer);
const renderCard = async () => {
	await act(async () => {
		cardRoot.render(react.createElement(exports.CpaSettingsCard, { scope: scopeStub.scope }));
		await Promise.resolve();
	});
};
await renderCard();

/** Live text reader: a captured `textContent` goes stale after every edit. */
function textNow() {
	return cardContainer.textContent ?? "";
}

const card = cardContainer.querySelector("[data-cpa-status-settings]");
check("settings card renders as a list item, like its neighbours", card?.tagName === "LI", card?.tagName);
const cardText = card?.textContent ?? "";
check("card names itself", cardText.includes("CPA 账号状态"));
check("card describes itself", cardText.includes(exports.zh["settings.description"]));
check("a clean card shows no unsaved marker", !cardText.includes("未保存"), cardText.slice(0, 120));
check("card is collapsed by default", card?.getAttribute("data-open") === null, String(card?.getAttribute("data-open")));
check("collapsed card exposes no controls", cardContainer.querySelector(".cps_setBody") === null);
check("its header is the disclosure control", cardContainer.querySelector(".cps_setHeader")?.getAttribute("aria-expanded") === "false");
check("its header carries a disclosure chevron", cardContainer.querySelector(".cps_setChevron") !== null);

const headerButton = cardContainer.querySelector(".cps_setHeader");
const toggleHeader = async () =>
	act(async () => {
		headerButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await Promise.resolve();
	});
await toggleHeader();
check("clicking the header opens the card", card?.getAttribute("data-open") === "1", String(card?.getAttribute("data-open")));
check("an open header reports aria-expanded", headerButton.getAttribute("aria-expanded") === "true");
check("an open card marks its chevron", cardContainer.querySelector(".cps_setChevron")?.getAttribute("data-open") === "1");
check("the open card renders every declared field", exports.SETTINGS_FIELDS.every((spec) => textNow().includes(exports.zh[spec.label])), String(exports.SETTINGS_FIELDS.length));

const inputFor = (field) => cardContainer.querySelector(`#cps-set-${field}`);
const ensureOpen = async () => {
	if (card.getAttribute("data-open") === null) await toggleHeader();
};
const setInput = async (field, value) => {
	await ensureOpen();
	const node = inputFor(field);
	await act(async () => {
		if (node.type === "checkbox") Simulate.change(node, { target: { checked: value === true } });
		else Simulate.change(node, { target: { value } });
		await Promise.resolve();
	});
};
const clickButton = async (label) => {
	// Opening is its own act: the button only exists once the body is rendered.
	await ensureOpen();
	await act(async () => {
		const button = [...cardContainer.querySelectorAll("button")].find((node) => node.textContent === label);
		button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
		await Promise.resolve();
	});
};
const buttonFor = (label) => [...cardContainer.querySelectorAll("button")].find((node) => node.textContent === label);

check("address field shows the resolved value", inputFor("baseURL")?.value === "https://cpa.example.com:8317", inputFor("baseURL")?.value);
check("millisecond fields are shown in seconds", inputFor("refreshIntervalMs")?.value === "300", inputFor("refreshIntervalMs")?.value);
check("proxy list renders one entry per line", inputFor("proxies")?.value === "http://127.0.0.1:1081\nhttp://127.0.0.1:1080", JSON.stringify(inputFor("proxies")?.value));
check("boolean fields render a checkbox", inputFor("includeDisabled")?.type === "checkbox" && inputFor("includeDisabled")?.checked === true);
check("the secret field is a password input", inputFor("managementKey")?.type === "password");
check("the secret field never echoes a stored value", inputFor("managementKey")?.value === "", JSON.stringify(inputFor("managementKey")?.value));
check(
	"the secret field explains the blank convention",
	inputFor("managementKey")?.placeholder === "留空表示不修改",
	inputFor("managementKey")?.placeholder
);
check("an overridden field is marked", textNow().includes("已覆盖"), textNow().slice(0, 160));
check("save starts disabled with no edits", buttonFor("保存")?.disabled === true);

const modeSelect = inputFor("badgeMode");
check("the badge mode renders as a select", modeSelect?.tagName === "SELECT", modeSelect?.tagName);
check(
	"the select offers both modes and shows the stored one",
	modeSelect?.value === "lowest" && [...(modeSelect?.options ?? [])].map((option) => option.value).join(",") === "lowest,total",
	`${modeSelect?.value} / ${[...(modeSelect?.options ?? [])].map((option) => option.value).join(",")}`
);
// The hint must speak the same words as the control: an earlier version explained
// the raw `lowest` / `total` values while the select showed localised labels, so a
// reader had to guess they meant the same choice.
for (const [locale, dict] of [["zh", exports.zh], ["en", exports.en]]) {
	check(
		`the badge-mode hint names both option labels (${locale})`,
		dict["settings.badgeMode.hint"].includes(dict["settings.badgeMode.lowest"]) &&
			dict["settings.badgeMode.hint"].includes(dict["settings.badgeMode.total"]),
		dict["settings.badgeMode.hint"]
	);
}
const beforeModeWrite = scopeStub.writes.length;
await setInput("badgeMode", "total");
await clickButton("保存");
check(
	"saving the badge mode writes it",
	scopeStub.writes.slice(beforeModeWrite).some((write) => write.op === "set" && write.field === "badgeMode" && write.value === "total"),
	JSON.stringify(scopeStub.writes.slice(beforeModeWrite))
);

// Editing the address and saving must write exactly that field.
await setInput("baseURL", "https://cpa.internal:8317");
check("a staged edit raises the unsaved marker", textNow().includes("未保存"), textNow().slice(0, 120));
check(
	"the unsaved marker is the shell Tag, like every other card",
	cardContainer.querySelector('.cps_setHeader [data-tag="neutral"]') !== null,
	cardContainer.querySelector(".cps_setHeader")?.innerHTML?.slice(0, 200)
);
check("save enables once something is staged", buttonFor("保存")?.disabled === false);
await clickButton("保存");
const addressWrite = scopeStub.writes.find((write) => write.field === "baseURL");
check("saving writes the edited address", addressWrite?.op === "set" && addressWrite.value === "https://cpa.internal:8317", JSON.stringify(addressWrite));
check("a landed save folds the card, like every other card", card.getAttribute("data-open") === null, String(card.getAttribute("data-open")));
check("a landed save drops the unsaved marker", !textNow().includes("未保存"), textNow().slice(0, 120));

// Seconds are converted back to the stored milliseconds.
await setInput("timeoutMs", "45");
await clickButton("保存");
const timeoutWrite = scopeStub.writes.find((write) => write.field === "timeoutMs");
check("a seconds field is stored in milliseconds", timeoutWrite?.value === 45000, JSON.stringify(timeoutWrite));

// A proxy list becomes an array, and blank lines are dropped.
await setInput("proxies", "socks5://127.0.0.1:1080\n\nhttp://127.0.0.1:8080");
await clickButton("保存");
const proxyWrite = scopeStub.writes.find((write) => write.field === "proxies");
check(
	"a proxy list is stored as an array without blanks",
	JSON.stringify(proxyWrite?.value) === JSON.stringify(["socks5://127.0.0.1:1080", "http://127.0.0.1:8080"]),
	JSON.stringify(proxyWrite)
);

// A blank secret is NOT an edit: it must never clear the stored key.
const writesBeforeSecret = scopeStub.writes.length;
await setInput("managementKey", "");
await clickButton("保存");
check(
	"a blank secret draft writes nothing at all",
	scopeStub.writes.length === writesBeforeSecret,
	JSON.stringify(scopeStub.writes.slice(writesBeforeSecret))
);

// Typing one does write it.
await setInput("managementKey", "s3cret-key");
await clickButton("保存");
const secretWrite = scopeStub.writes.find((write) => write.field === "managementKey");
check("a typed secret is written", secretWrite?.op === "set" && secretWrite.value === "s3cret-key", JSON.stringify(secretWrite));

// Clearing stages a reset that only the save performs — nothing is written on
// the click itself, which is the whole point of the staged-draft model.
scopeStub.writes.length = 0;
await clickButton("清除");
check("clearing alone writes nothing", scopeStub.writes.length === 0, JSON.stringify(scopeStub.writes));
check("clearing marks the card dirty", textNow().includes("未保存"), textNow().slice(0, 120));
await clickButton("保存");
check("saving a clear unsets the field", scopeStub.writes[0]?.op === "unset", JSON.stringify(scopeStub.writes[0]));
await ensureOpen();
check("the cleared field lost its override badge", (() => {
	const head = [...cardContainer.querySelectorAll(".cps_fieldHead")].find((node) => node.textContent.includes("CPA 地址"));
	return head !== undefined && !head.textContent.includes("已覆盖");
})(), "CPA 地址 still marked as overridden");

// Staged edits outlive collapsing — the header is what keeps reporting them.
await setInput("providerFilter", "codex-mini");
await toggleHeader();
check("collapsing keeps a staged edit", textNow().includes("未保存"), textNow().slice(0, 120));
check("a collapsed card hides its controls again", cardContainer.querySelector(".cps_setBody") === null);
await toggleHeader();
check("reopening restores the staged draft", inputFor("providerFilter")?.value === "codex-mini", inputFor("providerFilter")?.value);
await clickButton("放弃");

// Invalid drafts block the save and are reported.
await setInput("timeoutMs", "abc");
check("an invalid draft is reported", textNow().includes("有字段填写不正确"), textNow().slice(0, 120));
check("an invalid draft blocks the save", buttonFor("保存")?.disabled === true);
check("the invalid control is flagged", inputFor("timeoutMs")?.getAttribute("data-invalid") === "1");
await clickButton("放弃");
check("discard drops the invalid draft", buttonFor("保存")?.disabled === true && !textNow().includes("未保存"), textNow().slice(0, 120));

// Read-only storage keeps the card visible but inert.
const readOnly = createScopeStub({ value: { baseURL: "https://x:1" }, writable: false });
const readOnlyContainer = window.document.createElement("div");
window.document.body.appendChild(readOnlyContainer);
const readOnlyRoot = reactDomClient.createRoot(readOnlyContainer);
await act(async () => {
	readOnlyRoot.render(react.createElement(exports.CpaSettingsCard, { scope: readOnly.scope, t: undefined }));
	await Promise.resolve();
});
await act(async () => {
	readOnlyContainer.querySelector(".cps_setHeader").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await Promise.resolve();
});
check("a read-only namespace explains itself", readOnlyContainer.textContent.includes("当前设置为只读"), readOnlyContainer.textContent.slice(0, 140));
check("a read-only namespace disables its controls", readOnlyContainer.querySelector("input")?.disabled === true);
check("a read-only namespace cannot save", [...readOnlyContainer.querySelectorAll("button")].find((node) => node.textContent === "保存")?.disabled === true);
await act(async () => {
	readOnlyRoot.unmount();
	cardRoot.unmount();
});
//#endregion

//#region shell icon availability
// The shell is what supplies the seed `primitives` module, so verify the icons
// this panel asks for against the bundle that is actually installed.
const shellRoots = [
	process.env.DSH_WEB_SHELL,
	join(homedir(), ".dsh", "profiles", "web", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets"),
	"/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets"
].filter((entry) => typeof entry === "string" && entry !== "");
const shellAssets = shellRoots.find((entry) => existsSync(entry));
const shellBundles = shellAssets === undefined ? [] : globSync("index-*.js", { cwd: shellAssets });
if (shellBundles.length === 0) {
	process.stdout.write("  SKIP  installed shell bundle not found; icon check skipped\n");
} else {
	const shell = readFileSync(join(shellAssets, shellBundles[0]), "utf8");
	for (const name of ["IconGaugeOutline16", "IconRefreshOutline16", "IconCloseOutline16", "IconChevronDownOutline14", "Tag"]) {
		check(`shell primitives export ${name}`, shell.includes(`${name}:`), "icon falls back gracefully when absent");
	}
}
//#endregion

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
