#!/usr/bin/env node
/**
 * Re-capture the offline test fixtures from the live CPA deployment.
 *
 * The render and route tests run without network, so their inputs are real
 * captures kept under `test/fixtures/`. Re-run this after a CPA upgrade or when
 * an account changes shape, then re-run `npm test`.
 *
 *   node scripts/capture-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collectSnapshot, listErrorLogs, readErrorLog } from "../lib/cpa.js";
import { createClient, normalizeEntryConfig } from "../lib/index.js";
import { readEffectiveConfig } from "./patch-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");
mkdirSync(fixtures, { recursive: true });

const config = normalizeEntryConfig(readEffectiveConfig());
const client = createClient(config);
const write = (name, value) => {
	const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(join(fixtures, name), body, "utf8");
	process.stdout.write(`  wrote ${name} (${String(body.length)} bytes)\n`);
};

const snapshot = await collectSnapshot(client, config);
write("snapshot.json", { ...snapshot, fetchedAt: 1789659482025 });
process.stdout.write(
	`snapshot: ${String(snapshot.counts.total)} account(s), cpa ${String(snapshot.cpa.version)}${snapshot.cpa.updateAvailable ? ` (update ${String(snapshot.cpa.latestVersion)})` : ""}\n`
);

const listed = await listErrorLogs(client, config);
write("error-logs.json", listed);
process.stdout.write(`error logs: ${String(listed.files.length)} file(s), request-log=${String(listed.requestLogEnabled)}\n`);

if (listed.files.length > 0) {
	const log = await readErrorLog(client, config, listed.files[0].name);
	write("error-log.txt", log.text);
	process.stdout.write(
		`parsed: status ${String(log.status)} attempts ${String(log.attempts.length)} accounts ${log.accounts.map((account) => account.label).join(",")}\n`
	);
	write("error-log-parsed.json", log);
}
