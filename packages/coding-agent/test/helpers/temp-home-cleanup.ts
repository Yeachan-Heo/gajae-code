import { resetAgentDirFromEnvironment } from "@gajae-code/utils";
import { safeRmSync } from "../../../../scripts/safe-cleanup";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
	/**
	 * Captured GJC_CODING_AGENT_DIR. Presence of this key, including `undefined`,
	 * means restore it. Omission leaves the process override untouched so callers
	 * that only mock HOME cannot delete an unrelated profile redirect.
	 */
	originalAgentDir?: string | undefined;
	/** Captured PI_CODING_AGENT_DIR; same omitted-vs-undefined contract as originalAgentDir. */
	originalPiAgentDir?: string | undefined;
}

export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const state = getState();
		const { tempDir, tempHomeDir, originalHome } = state;
		// Restore the process-wide HOME override FIRST: a safe-cleanup refusal
		// below throws by design, and it must never leave the override active
		// for subsequent tests (which would redirect their state and cleanup
		// paths toward the temp home).
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		// Restore agent-dir overrides only when the caller captured them.
		// `originalAgentDir === undefined` after destructuring would also match
		// omitted fields and wipe a pre-existing GJC_CODING_AGENT_DIR.
		if ("originalAgentDir" in state) {
			if (state.originalAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = state.originalAgentDir;
		}
		if ("originalPiAgentDir" in state) {
			if (state.originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = state.originalPiAgentDir;
		}
		if ("originalAgentDir" in state || "originalPiAgentDir" in state) {
			resetAgentDirFromEnvironment();
		}
		// Fail-closed cleanup (issue #4794): the safe contract refuses the real
		// home, its ancestors, out-of-root aliases, symlink escapes, and
		// unowned paths instead of recursively deleting whatever the variable
		// happens to hold. A truthiness check alone never proved ownership.
		if (tempDir) safeRmSync(tempDir, { recursive: true, force: true });
		if (tempHomeDir) safeRmSync(tempHomeDir, { recursive: true, force: true });
	};
}
