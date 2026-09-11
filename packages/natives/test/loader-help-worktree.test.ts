/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/5484.
 *
 * A fresh `git worktree add` checkout has no built native addon, and the
 * loader's non-compiled failure message must name the worktree-safe setup
 * (`bun run setup:worktree`) rather than only the package-local build. Compiled
 * binaries are unaffected: their diagnostics stay download/extract oriented.
 *
 * The context is injected so the assertion does not depend on whether a real
 * addon happens to be loadable on the host.
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
	it("names the worktree-safe setup command when a workspace checkout has no addon", () => {
		const message = loadFailureMessage({
			context: {
				isCompiledBinary: false,
				isWorkspaceLoad: true,
				platformTag: "linux-x64",
				addonLabel: "linux-x64",
				addonFilenames: ["pi_natives.linux-x64.node"],
				versionedDir: "/cache/gjc/9.9.9",
				candidates: ["/repo/packages/natives/native/pi_natives.linux-x64.node"],
			},
			extractEmbeddedAddons: () => [],
			stageNodeModulesAddon: () => [],
			requireCandidate: () => {
				throw new Error("simulated missing native addon");
			},
		});

		expect(message).toContain("Failed to load pi_natives native addon for linux-x64");
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
