/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/5484.
 *
 * A fresh `git worktree add` checkout has no built native addon, and the
 * loader's non-compiled failure message must name the worktree-safe setup
 * (`bun run setup:worktree`) rather than only the package-local build. Compiled
 * binaries are unaffected: their diagnostics stay download/extract oriented.
 *
 * The workspace case deliberately runs the REAL loader context (no injected
 * `context`) so a regression that drops `isWorkspaceLoad` between
 * `initLoaderContext` and `buildHelpMessage` fails here instead of hiding
 * behind an injected flag.
 */
import { describe, expect, it } from "bun:test";
import { loadNative } from "../native/loader-state.js";

function loadFailureMessage(options: Parameters<typeof loadNative>[0]): string {
	try {
		loadNative(options);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected loadNative to throw");
}

describe("issue 5484: native loader failure guidance", () => {
	it("names the worktree-safe setup command through the real workspace loader context", () => {
		const message = loadFailureMessage({
			extractEmbeddedAddons: () => [],
			stageNodeModulesAddon: () => [],
			requireCandidate: () => {
				throw new Error("simulated missing native addon");
			},
		});

		expect(message).toContain("Failed to load pi_natives native addon for");
		expect(message).toContain("bun run setup:worktree");
	});

	it("keeps the worktree hint out of compiled-binary diagnostics", () => {
		const message = loadFailureMessage({
			context: {
				isCompiledBinary: true,
				platformTag: "linux-x64",
				addonLabel: "linux-x64",
				addonFilenames: ["pi_natives.linux-x64.node"],
				versionedDir: "/cache/gjc/9.9.9",
				candidates: [],
			},
			extractEmbeddedAddons: () => [],
			stageNodeModulesAddon: () => [],
			requireCandidate: () => {
				throw new Error("simulated missing native addon");
			},
		});

		expect(message).toContain("The compiled binary should extract one of");
		expect(message).not.toContain("bun run setup:worktree");
	});
});
