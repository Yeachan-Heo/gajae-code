import { describe, expect, it } from "bun:test";
import { resetShellConfigCache } from "@gajae-code/utils/shell-config";
import { disposeAllShellSessions, executeBash } from "../src/exec/bash-executor";

/**
 * Regression test for #6883: Default bash execution should not impersonate CI.
 * Issue #6883 reported that tools like node-llama-cpp and test runners
 * behave differently on CI, so GJC non-interactive bash must not inject CI=true
 * by default. A per-call env can inherit CI from the parent process, but the
 * spawn environment must not add it if it was not already present.
 *
 * This test actually spawns bash and checks the child environment.
 */

describe("bash spawn environment CI regression", () => {
	it("does not inject CI into non-interactive bash when not inherited", async () => {
		// Ensure CI is not in the parent environment for this test.
		const ciWasSet = "CI" in Bun.env;
		const originalCI = Bun.env.CI;
		delete Bun.env.CI;

		try {
			// The persistent shell imports the process environment at spawn, so a
			// prior test's shell would keep the old CI. Start from a fresh shell.
			await disposeAllShellSessions();
			await disposeAllShellSessions();
			// The spawn environment is memoized in the shell config, so a copy
			// cached while CI was set would keep injecting it.
			resetShellConfigCache();
			// Run bash with a command that checks the CI variable.
			// If CI is set, it will exit with code 1; if unset, code 0.
			const result = await executeBash('if [ -z "$CI" ]; then exit 0; else exit 1; fi');

			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
		} finally {
			// Restore the original state.
			if (ciWasSet) {
				Bun.env.CI = originalCI!;
			} else {
				delete Bun.env.CI;
			}
			resetShellConfigCache();
		}
	});

	it("preserves inherited CI in the spawned bash environment", async () => {
		const originalCI = Bun.env.CI;
		Bun.env.CI = "true";

		try {
			await disposeAllShellSessions();
			await disposeAllShellSessions();
			// The spawn environment is memoized in the shell config, so the
			// inherited CI only reaches the child after the cache is dropped.
			resetShellConfigCache();
			// Run bash with a command that checks the CI variable.
			// If CI is set, it will exit with code 0; if unset, code 1.
			const result = await executeBash('if [ -n "$CI" ]; then exit 0; else exit 1; fi');

			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
		} finally {
			// Restore the original state.
			if (originalCI === undefined) {
				delete Bun.env.CI;
			} else {
				Bun.env.CI = originalCI;
			}
			resetShellConfigCache();
		}
	});
});
