/**
 * dsh-cpa-monitor — schemastery loader.
 *
 * The settings service needs a REAL schemastery schema: it calls the schema as
 * a function to resolve a section (`schema(value)`), serializes it for
 * configuration UIs (`schema.toJSON()`), and walks it to redact `role('secret')`
 * fields. A hand-rolled Standard Schema object satisfies none of that, so this
 * one package is a genuine dependency — unlike the rest of the server half,
 * which stays on `node:` builtins alone.
 *
 * It is pinned to the exact version the harness ships, and resolved through a
 * short fallback chain because a profile plugin is `link:`-installed and
 * therefore resolves from its own real path:
 *
 *   1. this package's own `node_modules` (the normal case: `npm install` here)
 *   2. any profile under `$DSH_HOME/profiles` — the host's own copy, so a
 *      checkout moved without `node_modules` still boots
 *
 * @module dsh-cpa-monitor/schema
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The exact schemastery version the harness ships; keep the pin in step. */
export const SCHEMASTERY_VERSION = "3.18.4";

/** Package specifier, exported so the checker can assert the pin. */
export const SCHEMASTERY_MODULE = "@deepseek-ai/schemastery";

/** Resolve the harness home the same way the harness does. */
function harnessHome() {
	const configured = process.env.DSH_HOME;
	return configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh");
}

/**
 * Every candidate anchor this package will try, most specific first.
 * @returns absolute package.json paths and bare module directories.
 */
function candidateAnchors() {
	const home = harnessHome();
	const anchors = [];
	const profiles = join(home, "profiles");
	if (existsSync(profiles)) {
		for (const entry of readdirSync(profiles)) {
			const manifest = join(profiles, entry, "package.json");
			if (existsSync(manifest)) anchors.push(manifest);
		}
	}
	return anchors;
}

/** A schemastery module is usable when its default export is callable. */
function usable(candidate) {
	const value = candidate?.default ?? candidate;
	return typeof value === "function" ? value : undefined;
}

/**
 * Load schemastery, preferring this package's own dependency.
 *
 * SYNCHRONOUS on purpose. A host reads a plugin's `Config` export while it
 * resolves the entry, and a plugin module that needs top-level `await` to
 * produce it is a needless compatibility risk: `require()` of an ESM module
 * throwing `ERR_REQUIRE_ASYNC_MODULE` would fail the whole entry, not merely
 * cost the form. schemastery ships a `require` build (`lib/index.cjs`), so
 * `createRequire` works on every supported Node version.
 *
 * @returns the schemastery default export.
 * @throws {Error} with every attempted location when none resolves.
 */
export function loadSchemastery() {
	const attempts = [];
	for (const anchor of [import.meta.url, ...candidateAnchors()]) {
		try {
			const resolved = usable(createRequire(anchor)(SCHEMASTERY_MODULE));
			if (resolved !== undefined) return resolved;
			attempts.push(`${anchor}: not callable`);
		} catch (error) {
			attempts.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(
		`cpa-monitor: cannot load ${SCHEMASTERY_MODULE}@${SCHEMASTERY_VERSION} — ` +
			`run \`npm install\` inside the dsh-cpa-monitor package directory. Tried: ${attempts.join("; ")}`
	);
}
