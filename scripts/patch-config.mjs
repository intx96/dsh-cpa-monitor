#!/usr/bin/env node
/**
 * Read this package's configuration the way the plugin resolves it.
 *
 * Two layers matter to a script:
 *
 *   composition (`cordis.patch.yml` in this package)
 *     → user layer (`$DSH_HOME/settings.yaml`, namespace `cpa-monitor`)
 *
 * The committed patch is deliberately secret-free, so the deployment's real
 * endpoint and management key live only in the user layer — which is also where
 * the plugin's own Settings card writes them. Tools must therefore read the
 * COMPOSED value, exactly like the running plugin does.
 *
 * YAML, not regexes: the patch documents its alternatives in comments (including
 * a sample `baseURL`), and a regex cannot tell a comment from the real value.
 * js-yaml comes from the harness install, since the plugin package deliberately
 * does not depend on it.
 *
 * @module scripts/patch-config
 */

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const DSH_ANCHOR = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json";

/** The namespace the plugin registers and the Settings card writes. */
export const SETTINGS_NAMESPACE = "cpa-monitor";

/** Harness home, resolved the way the harness resolves it. */
function harnessHome() {
	const configured = process.env.DSH_HOME;
	return configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh");
}

/**
 * Parse the bundle patch and return the composition config it mounts.
 * @returns the `config` object of the single inserted entry.
 */
export function readPatchConfig() {
	const yaml = createRequire(DSH_ANCHOR)("js-yaml");
	const patch = yaml.load(readFileSync(join(here, "..", "cordis.patch.yml"), "utf8"));
	const inserted = (Array.isArray(patch) ? patch : []).flatMap((entry) => entry?.insert ?? []);
	if (inserted.length !== 1) throw new Error(`cordis.patch.yml must insert exactly one entry, found ${String(inserted.length)}`);
	if (inserted[0].config === undefined) throw new Error("cordis.patch.yml entry has no config block");
	return inserted[0].config;
}

/**
 * Read this deployment's `cpa-monitor` section from the harness user settings.
 * @returns the stored section, or undefined when the file or namespace is absent.
 */
export function readUserLayer() {
	const file = join(harnessHome(), "settings.yaml");
	if (!existsSync(file)) return undefined;
	const yaml = createRequire(DSH_ANCHOR)("js-yaml");
	const document = yaml.load(readFileSync(file, "utf8"));
	if (document === null || typeof document !== "object") return undefined;
	const section = document[SETTINGS_NAMESPACE];
	return section !== null && typeof section === "object" ? section : undefined;
}

/**
 * Resolve the configuration the running plugin would use: composition, then the
 * user layer on top.
 * @returns the composed configuration object.
 */
export function readEffectiveConfig() {
	return { ...readPatchConfig(), ...(readUserLayer() ?? {}) };
}
