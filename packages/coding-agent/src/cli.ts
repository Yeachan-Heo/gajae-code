#!/usr/bin/env bun

/** Inert CLI entry.
 *
 * `bin/gjc.js` imports THIS module, so anything statically imported here runs
 * before argv is inspected. Keep it to pure metadata: the read-only
 * `sdk diagnostics` observation route must not be able to resolve directories,
 * consult NSS for a missing/ambiguous HOME, load the native addon, install
 * runtime globals, re-exec for malloc env vars, run managed-owner admission or
 * recovery, or touch the error-evidence store. Everything effectful lives in
 * `./cli-ordinary`, which is imported lazily for every other command with its
 * original ordering and admission semantics. */

import { APP_NAME, formatBunRuntimeError, MIN_BUN_VERSION } from "@gajae-code/utils/cli-metadata";
import { commands } from "./cli-commands";

export { commands };

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		formatBunRuntimeError({ currentVersion: Bun.version, minVersion: MIN_BUN_VERSION, execPath: process.execPath }),
	);
	process.exit(1);
}
process.title = APP_NAME;

/** Run the CLI with argv excluding process.argv prefix. */
export async function runCli(argv: string[]): Promise<void> {
	// Exact-token diagnostics selector, ahead of every effectful branch. A private
	// worker marker AFTER this prefix is a diagnostics usage error, never a worker
	// dispatch; a private marker BEFORE it is not a diagnostics invocation at all
	// and keeps its ordinary admission below.
	if (argv[0] === "sdk" && argv[1] === "diagnostics") {
		try {
			const { runDiagnosticsCli } = await import("./sdk/cli/diagnostics-cli");
			await runDiagnosticsCli(argv.slice(2));
		} catch {
			process.stderr.write("gjc sdk diagnostics: observation unavailable\n");
			process.exitCode = 2;
		}
		return;
	}
	const { runOrdinaryCli } = await import("./cli-ordinary");
	await runOrdinaryCli(argv);
}

if (import.meta.main) await runCli(process.argv.slice(2));
