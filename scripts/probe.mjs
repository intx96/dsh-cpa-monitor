#!/usr/bin/env node
/**
 * Live probe for the server half.
 *
 * Runs the exact snapshot collector the plugin runs, so a green run proves the
 * proxy chain, the management key, the account discovery, and the usage parser
 * all work against the real CLIProxyAPI deployment.
 *
 *   node scripts/probe.mjs               # snapshot summary
 *   node scripts/probe.mjs --json        # full snapshot JSON
 *
 * Config comes from `cordis.patch.yml` in this package, so the probe always
 * exercises the shipped defaults.
 */

import { collectSnapshot } from "../lib/cpa.js";
import { createClient, normalizeEntryConfig } from "../lib/index.js";
import { readEffectiveConfig } from "./patch-config.mjs";

const config = normalizeEntryConfig(readEffectiveConfig());
const client = createClient(config);
const snapshot = await collectSnapshot(client, config);

if (process.argv.includes("--json")) {
	process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else {
	process.stdout.write(
		`transport: ${String(snapshot.proxy)}   accounts: ${String(snapshot.counts.total)}   ` +
			`active: ${String(snapshot.counts.active)}   attention: ${String(snapshot.attention)}   ` +
			`min remaining: ${snapshot.minRemaining === null ? "—" : `${String(snapshot.minRemaining)}%`}   ` +
			`${String(snapshot.durationMs)}ms\n`
	);
	for (const account of snapshot.accounts) {
		const windows = account.windows.map((window) => `${window.label} ${String(window.remaining)}% → ${window.resetText}`).join("  |  ");
		process.stdout.write(
			`  ${account.email || account.authIndex}\n` +
				`    status=${account.status}${account.disabled ? " (disabled)" : ""} plan=${account.plan} ok=${String(account.usable)}\n` +
				`    ${windows || "no rate-limit windows"}\n` +
				`    summary=${account.summary}  success=${String(account.success)} failed=${String(account.failed)}` +
				`${account.error === null || account.error === undefined ? "" : `\n    error=${account.error}`}\n`
		);
	}
	if (snapshot.errors.length > 0) process.stdout.write(`  snapshot errors: ${snapshot.errors.join("; ")}\n`);
}
