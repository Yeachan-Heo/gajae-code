/**
 * Shared types for RLM (research) mode.
 */
import type { KernelDisplayOutput } from "../eval/py/kernel";

export interface RlmArtifactPaths {
	/** Absolute session directory: <cwd>/.gjc/rlm/<sessionId>/ */
	dir: string;
	/** Absolute path to the live notebook.ipynb */
	notebookPath: string;
	/** Absolute path to the synthesized report.md */
	reportPath: string;
	/** Absolute path to the session metadata.json */
	metadataPath: string;
	/** Directory for the underlying GJC conversation session files. */
	agentSessionDir: string;
}

/** Outcome of a single RLM python cell execution. */
export interface RlmCellResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	displayOutputs: KernelDisplayOutput[];
}

export interface RlmSessionMetadata {
	sessionId: string;
	createdAt: string;
	cwd: string;
	dataPath: string | null;
	cellCount: number;
	mode?: "interactive" | "autonomous";
	resumedFrom?: string | null;
	completedAt?: string | null;
	finalSummary?: string | null;
	minSuccessfulRuns?: number;
	successfulRuns?: number;
}
