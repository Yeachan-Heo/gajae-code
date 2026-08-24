import { safeRmSync } from "../../../../scripts/safe-cleanup";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
	/** Captured GJC_CODING_AGENT_DIR; restored so a redirected agent dir never leaks. */
	originalAgentDir?: string | undefined;
}

export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const { tempDir, tempHomeDir, originalHome, originalAgentDir } = getState();
		// Restore the process-wide HOME override FIRST: a safe-cleanup refusal
		// below throws by design, and it must never leave the override active
		// for subsequent tests (which would redirect their state and cleanup
		// paths toward the temp home).
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		// Native user-scope surfaces follow the agent directory, so a test that
		// redirects it must restore it before cleanup continues.
		if (originalAgentDir === undefined) {
			delete process.env.GJC_CODING_AGENT_DIR;
		} else if (originalAgentDir) {
			process.env.GJC_CODING_AGENT_DIR = originalAgentDir;
		}
		// Fail-closed cleanup (issue #4794): the safe contract refuses the real
		// home, its ancestors, out-of-root aliases, symlink escapes, and
		// unowned paths instead of recursively deleting whatever the variable
		// happens to hold. A truthiness check alone never proved ownership.
		if (tempDir) safeRmSync(tempDir, { recursive: true, force: true });
		if (tempHomeDir) safeRmSync(tempHomeDir, { recursive: true, force: true });
	};
}
