import {
	scanWorktrees,
	type WorktreeDiagnostic,
	WorktreeRootError,
	type WorktreeScannerPlatform,
} from "./worktree-scanner";

export interface RunWorktreeCommandOptions {
	root: string;
	platform: WorktreeScannerPlatform;
	action: "list" | "clear";
	json: boolean;
	dryRun: boolean;
}

export interface RunWorktreeCommandResult {
	stdout: string;
	stderr: string;
	exitCode: 0 | 1;
}

const SCAN_ERROR_TEXT = "managed worktree root cannot be read";

export async function runWorktreeCommand(options: RunWorktreeCommandOptions): Promise<RunWorktreeCommandResult> {
	let diagnostics: WorktreeDiagnostic[];
	try {
		diagnostics = await scanWorktrees({ root: options.root, platform: options.platform });
	} catch (error) {
		if (!(error instanceof WorktreeRootError)) throw error;
		return options.json
			? {
					stdout: `${JSON.stringify({ error: { code: "worktree_scan_failed", message: SCAN_ERROR_TEXT } })}\n`,
					stderr: "",
					exitCode: 1,
				}
			: { stdout: "", stderr: `error: ${SCAN_ERROR_TEXT}\n`, exitCode: 1 };
	}
	if (options.action === "list") {
		if (options.json) return { stdout: `${JSON.stringify(diagnostics)}\n`, stderr: "", exitCode: 0 };
		if (diagnostics.length === 0) return { stdout: "No agent-managed worktrees found.\n", stderr: "", exitCode: 0 };
		return {
			stdout: `${diagnostics.map(formatDiagnostic).join("\n")}\n\n${diagnostics.length} total\n`,
			stderr: "",
			exitCode: 0,
		};
	}

	if (options.dryRun || diagnostics.length === 0) {
		if (options.json) {
			return {
				stdout: `${JSON.stringify(options.dryRun ? { wouldRemove: [] } : { removed: 0, kept: 0 })}\n`,
				stderr: "",
				exitCode: 0,
			};
		}
		return { stdout: "No worktrees are eligible for removal; cleanup is report-only.\n", stderr: "", exitCode: 0 };
	}

	if (options.json) {
		return { stdout: `${JSON.stringify({ removed: 0, kept: diagnostics.length })}\n`, stderr: "", exitCode: 0 };
	}
	return {
		stdout: `${diagnostics.map(diagnostic => `kept    ${diagnostic.path}`).join("\n")}\n\n0 removed · ${diagnostics.length} kept\n`,
		stderr: "",
		exitCode: 0,
	};
}

function formatDiagnostic(diagnostic: WorktreeDiagnostic): string {
	return `diagnostic  ${diagnostic.path}  ${diagnostic.message}`;
}
