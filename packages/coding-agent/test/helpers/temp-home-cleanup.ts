import { safeRmSync } from "../../../../scripts/safe-cleanup";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
}

export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const { tempDir, tempHomeDir, originalHome } = getState();
		// Fail-closed cleanup (issue #4794): the safe contract refuses the real
		// home, its ancestors, out-of-root aliases, symlink escapes, and
		// unowned paths instead of recursively deleting whatever the variable
		// happens to hold. A truthiness check alone never proved ownership.
		if (tempDir) safeRmSync(tempDir, { recursive: true, force: true });
		if (tempHomeDir) safeRmSync(tempHomeDir, { recursive: true, force: true });
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	};
}
