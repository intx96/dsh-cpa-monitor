#!/usr/bin/env node
/**
 * Static contract checks for the plugin package.
 *
 * Everything here guards a failure mode that is silent until the GUI loads:
 * a mistyped manifest field means the bundle is never scanned, a `require()`
 * outside the shell's seed table throws only in the browser, and a bare
 * package import in the server half cannot resolve at all once the package is
 * `link:`-installed into a profile (its real path has no node_modules).
 *
 *   node scripts/check.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readEffectiveConfig } from "./patch-config.mjs";
import { Config, plainEntryConfig } from "../lib/index.js";
import { listErrorLogs, parseErrorLog } from "../lib/cpa.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const failures = [];
const notes = [];

/**
 * Record one assertion.
 * @param label - what was checked.
 * @param ok - the result.
 * @param detail - context printed on failure.
 */
function check(label, ok, detail) {
	if (ok) notes.push(`  ok    ${label}`);
	else failures.push(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

//#region manifest
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
check("package.json has a name", typeof manifest.name === "string" && manifest.name !== "");
check("package is ESM", manifest.type === "module");
check("main entry exists", existsSync(join(packageDir, manifest.main ?? "")), manifest.main);
check("dsh.bundle.patch is declared", typeof manifest.dsh?.bundle?.patch === "string", JSON.stringify(manifest.dsh?.bundle));
check("dsh.bundle.patch file exists", existsSync(join(packageDir, manifest.dsh?.bundle?.patch ?? "")), manifest.dsh?.bundle?.patch);
check("dsh.client.platform is web", manifest.dsh?.client?.platform === "web", String(manifest.dsh?.client?.platform));
check(
	"dsh.client.inject is a string array",
	Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.every((entry) => typeof entry === "string"),
	JSON.stringify(manifest.dsh?.client?.inject)
);
const clientExport = manifest.exports?.["./client"];
const clientRel = typeof clientExport === "string" ? clientExport : clientExport?.default;
check('exports["./client"] resolves', typeof clientRel === "string" && existsSync(join(packageDir, clientRel)), JSON.stringify(clientExport));
//#endregion

//#region patch layer
const patchText = readFileSync(join(packageDir, manifest.dsh.bundle.patch), "utf8");
let patch;
try {
	const require = createRequire("/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json");
	patch = require("js-yaml").load(patchText);
} catch (error) {
	notes.push(`  skip  cordis.patch.yml YAML parse (js-yaml unavailable: ${error instanceof Error ? error.message : String(error)})`);
}
if (patch !== undefined) {
	check("patch is an array of entries", Array.isArray(patch), typeof patch);
	const inserted = patch.flatMap((entry) => entry?.insert ?? []);
	check("patch inserts exactly one entry", inserted.length === 1, String(inserted.length));
	check("inserted entry id is the plugin identity", inserted[0]?.id === "cpa-monitor", String(inserted[0]?.id));
	check("inserted entry name matches the package", inserted[0]?.name === manifest.name, String(inserted[0]?.name));
	const config = inserted[0]?.config ?? {};
	// The committed patch must stay secret-free: the deployment's real endpoint and
	// key live in the user layer, so publishing this file cannot leak them.
	check("committed patch carries no managementKey", config.managementKey === undefined, JSON.stringify(config.managementKey)?.slice(0, 20));
	check("committed patch points at a placeholder endpoint", config.baseURL === "https://cpa.example.com:8317", String(config.baseURL));
	check("config carries proxy candidates", Array.isArray(config.proxies) && config.proxies.length > 0, JSON.stringify(config.proxies));
	check("config pins allowDirect explicitly", typeof config.allowDirect === "boolean", String(config.allowDirect));
	const deployedKey = readEffectiveConfig().managementKey;
	notes.push(
		typeof deployedKey === "string" && deployedKey !== ""
			? "  note  this deployment supplies a management key (patch + user layer + env)"
			: "  note  no management key in this deployment — set it in the Settings card or via DSH_CPA_MANAGEMENT_KEY"
	);
}
//#endregion

//#region module hygiene
const SEEDS = new Set([
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-dockkit"
]);
const clientSource = readFileSync(join(packageDir, clientRel), "utf8");
const clientRequires = [...clientSource.matchAll(/\brequire\("([^"]+)"\)/g)].map((match) => match[1]);
check("client bundle requires at least react", clientRequires.includes("react"), JSON.stringify(clientRequires));
const unknownRequires = clientRequires.filter((specifier) => !SEEDS.has(specifier));
check("client bundle only requires shell seed words", unknownRequires.length === 0, JSON.stringify(unknownRequires));
check("client bundle targets __ModuleLoader__", clientSource.includes("window.__ModuleLoader__.load("));
check("client bundle declares its package id", clientSource.includes(`id: "${manifest.name}"`));

// A `link:`-installed profile plugin resolves from its OWN real path, so a bare
// import only works when this package actually depends on it. schemastery is
// the one such import, and it must be an exact pin: the settings service calls
// the schema, serializes it, and walks it, so an unexpected version is a real
// incompatibility rather than a cosmetic drift.
const ALLOWED_BARE = new Set(["@deepseek-ai/schemastery"]);
for (const file of ["lib/index.js", "lib/cpa.js", "lib/net.js", "lib/schema.js"]) {
	const source = readFileSync(join(packageDir, file), "utf8");
	const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
	const bare = specifiers.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith(".") && !ALLOWED_BARE.has(specifier));
	check(`${file} imports only node: builtins, relative paths, and the allowed schema package`, bare.length === 0, JSON.stringify(bare));
}

const schemaPin = manifest.dependencies?.["@deepseek-ai/schemastery"];
check("schemastery is a declared dependency", typeof schemaPin === "string", JSON.stringify(manifest.dependencies));
check("schemastery is pinned exactly", typeof schemaPin === "string" && /^\d+\.\d+\.\d+$/.test(schemaPin), String(schemaPin));
check(
	"schemastery is installed next to the package",
	existsSync(join(packageDir, "node_modules", "@deepseek-ai", "schemastery", "package.json")),
	"run `npm install` in the package directory"
);
const installedSchema = existsSync(join(packageDir, "node_modules", "@deepseek-ai", "schemastery", "package.json"))
	? JSON.parse(readFileSync(join(packageDir, "node_modules", "@deepseek-ai", "schemastery", "package.json"), "utf8")).version
	: undefined;
check("the installed schema version matches the pin", installedSchema === schemaPin, `${String(installedSchema)} vs ${String(schemaPin)}`);
//#endregion

//#region test harness presence
// The render harness is a development convenience, not something the package
// ships — a fresh clone legitimately has none, so this reports rather than fails.
const testEnv = join(packageDir, ".test-env", "node_modules");
const harness = existsSync(join(testEnv, "react")) && existsSync(join(testEnv, "jsdom"));
notes.push(
	harness
		? "  note  render harness present, so `npm test` can run the client suite"
		: "  note  no render harness (`.test-env`): the server suite runs, the client suite needs (cd .test-env && npm install react@18 react-dom@18 jsdom)"
);
for (const name of ["snapshot.json", "error-logs.json", "error-log.txt", "error-log-parsed.json"]) {
	check(`fixture ${name} present`, existsSync(join(packageDir, "test", "fixtures", name)));
}
check("fixtures can be re-captured", existsSync(join(packageDir, "scripts", "capture-fixtures.mjs")));

// Repo-wide secret sweep: anything a publish would carry.
const TRACKED = [
	"README.md",
	"package.json",
	"cordis.patch.yml",
	"lib/index.js",
	"lib/client.js",
	"lib/cpa.js",
	"lib/net.js",
	"lib/schema.js",
	"scripts/check.mjs",
	"scripts/probe.mjs",
	"scripts/patch-config.mjs",
	"scripts/capture-fixtures.mjs",
	"scripts/smoke-server.mjs",
	"scripts/smoke-client.mjs",
	"test/fixtures/snapshot.json",
	"test/fixtures/error-logs.json",
	"test/fixtures/error-log.txt",
	"test/fixtures/error-log-parsed.json"
];
// Obviously-fake stand-ins are not leaks; the hermetic test config needs one.
const FAKE_MARKERS = /(fake|example|dummy|redacted|placeholder|sample|test-key)/i;
const SECRET_PATTERNS = [
	/\beyJ[A-Za-z0-9_-]{10,}/, // a JWT
	/\bsk-[A-Za-z0-9_-]{12,}/, // an API key literal
	// A secret pasted next to a secret-shaped name. Identifiers like
	// `inFlightToken = undefined` or `managementKey: ""` must not match, so the
	// value has to be a non-trivial quoted literal.
	/\b(?:managementKey|apiKey|api_key|apikey|secret|password|passwd|token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
	// A mailbox that is not documentation's own example domain.
	/[A-Za-z0-9._%+-]+@(?!example\.com|example\.[a-z]+)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
];
let leaked = 0;
for (const file of TRACKED) {
	const source = readFileSync(join(packageDir, file), "utf8");
	for (const pattern of SECRET_PATTERNS) {
		const hit = pattern.exec(source);
		if (hit === null || FAKE_MARKERS.test(hit[0])) continue;
		leaked += 1;
		failures.push(`  FAIL  ${file} contains a secret-shaped literal: ${hit[0].slice(0, 24)}…`);
	}
}
check("no secret-shaped literal in tracked sources", leaked === 0, `${String(leaked)} hit(s)`);

// Rename completeness: a half-renamed plugin is the kind of thing that only
// shows up as a confusing runtime error, so pin the identity strings here.
const STALE_IDENTITY = [
	"dsh-cpa-status",
	"/api/cpa-status",
	'"cpa-status"',
	"x-dsh-cpa-status-action"
];
let stale = 0;
for (const file of TRACKED) {
	// This file is where the needles are written down, so it is the one place
	// they are expected to appear.
	if (file === "scripts/check.mjs") continue;
	const source = readFileSync(join(packageDir, file), "utf8");
	for (const needle of STALE_IDENTITY) {
		if (!source.includes(needle)) continue;
		stale += 1;
		failures.push(`  FAIL  ${file} still carries the old identity "${needle}"`);
	}
}
check("no stale identity string in tracked sources", stale === 0, `${String(stale)} hit(s)`);
check("the package identity is the current name", manifest.name === "dsh-cpa-monitor", String(manifest.name));
check("patch-config helper reads YAML, not regexes", existsSync(join(packageDir, "scripts", "patch-config.mjs")));
const shellRoots = [
	process.env.DSH_WEB_SHELL,
	join(homedir(), ".dsh", "profiles", "web", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets"),
	"/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets"
].filter(Boolean);
// Where the shell bundle lives is a deployment fact, not a package contract: a
// machine that has not installed the harness yet legitimately has none. The icon
// check in smoke-client.mjs skips itself in that case, so this only records the
// search.
const shellFound = shellRoots.find((entry) => existsSync(entry));
if (shellFound === undefined) {
	notes.push(`  note  shell bundle absent (looked in ${shellRoots.join(", ")}); the client icon check will skip`);
} else {
	notes.push(`  ok    installed shell assets found (for the icon check)`);
}
//#endregion

//#region entry-config schema
// The 0.2 Plugins page builds a row's configuration form out of the `Config` this
// package exports: `dsh-settings` projects a form only when `"toJSON" in Config`,
// and reads `type` / `dict` off the live object to decide which fields are even
// editable. A Standard Schema object satisfies neither, so the row would get a
// configure control that opens nothing — and a migrated `settings.yaml` section
// would not be importable. These assertions pin that contract.
// A live-editable field does not resolve to a VALUE on the host's patched
// schemastery: it resolves to a writable cell the host writes into and announces
// with `loader/volatile-update`. `plainEntryConfig` is the single place that
// turns a resolved section back into plain values, so these read through it —
// exactly as the runtime does.
check("Config validates an entry", (() => {
	try {
		return plainEntryConfig(Config({ baseURL: "https://cpa.example.com:8317" })).baseURL === "https://cpa.example.com:8317";
	} catch {
		return false;
	}
})());
check(
	"Config applies schema defaults",
	plainEntryConfig(Config({})).refreshIntervalMs === 300000 && plainEntryConfig(Config({})).badgeMode === "lowest"
);
check("Config rejects an unknown badge mode", (() => {
	try {
		Config({ badgeMode: "nope" });
		return false;
	} catch {
		return true;
	}
})());
check(
	"a live-editable field resolves to a writable cell",
	typeof plainEntryConfig === "function" &&
		Object.values(Config({})).some((field) => field !== null && typeof field === "object" && typeof field.get === "function"),
	"an unpatched schemastery resolves plain values, which is also accepted"
);
if ("toJSON" in Config) {
	check("Config serializes for the host's schema projection", typeof Config.toJSON === "function");
	check("Config is an object schema the form projector understands", Config.type === "object" && Config.dict !== undefined);
	const fields = Object.keys(Config.dict ?? {}).sort();
	check(
		"Config declares every editable field",
		fields.length === 12 && fields.includes("baseURL") && fields.includes("managementKey") && fields.includes("badgeMode"),
		fields.join(",")
	);
	check("Config marks the management key as a secret", Config.dict?.managementKey?.meta?.role === "secret");
	// Polarity matters and is easy to get backwards: the host's form keeps ONLY
	// fields whose nearest `meta.volatile` ancestor exists (`volatileForm()`),
	// and its write path refuses any path outside a volatile node. A schema that
	// marks nothing validates fine and still yields NO form — the row gets a
	// configure control that opens an empty page. Official entries do the same
	// (`@deepseek-ai/dsh-subagent`'s `static Config` marks every field volatile),
	// and this assertion is what caught the shipped schema getting it wrong.
	const volatileFields = Object.entries(Config.dict ?? {}).filter(([, field]) => field?.meta?.volatile === true);
	check(
		"Config marks every field volatile, the host's word for live-editable",
		volatileFields.length === 12,
		`${String(volatileFields.length)}/12 volatile: ${volatileFields.map(([name]) => name).join(",")}`
	);
} else {
	notes.push("  note  schemastery absent — Config fell back to Standard Schema, so the 0.2 configuration form is unavailable (run npm install)");
}
//#endregion

//#region log timestamps
// Both clocks the failures list shows used to read a wall clock as UTC, which put
// every entry eight hours late on a +08:00 deployment: the file name was parsed
// with a forced `Z`, and CPA's absolute `modified` was treated as a fallback
// instead of the authority. These are pure functions with a fake transport, so
// the regression lives here — the integration suite needs a harness install and
// would not always run.
const zonedLog = parseErrorLog(
	"error-v1-responses-2026-09-30T122726-deadbeef.log",
	"=== API REQUEST 1 ===\nTimestamp: 2026-09-30T12:27:26.964971546+08:00\nAuth: provider=codex, auth_id=alpha.json, label=alpha@example.com\n"
);
// The same instant spelled with its offset, so the assertion states the rule
// rather than a number: `12:27:26.964+08:00` IS `04:27:26.964Z`.
check(
	"a body stamp's own offset decides the instant",
	zonedLog.at === Date.parse("2026-09-30T12:27:26.964+08:00"),
	`${String(zonedLog.at)} vs ${String(Date.parse("2026-09-30T12:27:26.964+08:00"))}`
);
const nameOnlyLog = parseErrorLog("error-v1-responses-2026-09-30T122726-deadbeef.log", "=== API REQUEST 1 ===\n");
check(
	"a file-name fallback is read in the host's zone, not as UTC",
	nameOnlyLog.at === new Date(2026, 8, 30, 12, 27, 26).getTime(),
	`${String(nameOnlyLog.at)} vs ${String(new Date(2026, 8, 30, 12, 27, 26).getTime())}`
);
const fakeListingClient = {
	request: async (url) =>
		url.includes("request-log")
			? { status: 404, body: "" }
			: {
					status: 200,
					body: JSON.stringify({
						files: [
							{ name: "error-v1-responses-2026-09-30T122726-deadbeef.log", size: 12, modified: 1789448655 },
							{ name: "not-a-log.txt", size: 1, modified: 1789448600 }
						]
					})
				}
};
const listing = await listErrorLogs(fakeListingClient, { baseURL: "https://cpa.example.com:8317", managementKey: "k" }, 5);
check("a listing entry prefers CPA's absolute modified time", listing.files[0]?.at === 1789448655000, String(listing.files[0]?.at));
check("the listing keeps every file CPA reports", listing.files.length === 2, String(listing.files.length));
//#endregion

process.stdout.write(`${notes.join("\n")}\n`);
if (failures.length > 0) {
	process.stdout.write(`${failures.join("\n")}\n`);
	process.stdout.write(`\n${String(failures.length)} contract check(s) failed\n`);
	process.exit(1);
}
process.stdout.write(`\nall ${String(notes.length)} contract checks passed\n`);
