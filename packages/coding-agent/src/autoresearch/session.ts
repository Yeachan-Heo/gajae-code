/**
 * Persistent mission kernel + notebook wiring: builds the live notebook writer
 * and the mission `python` tool from persisted mission state, reusing the
 * existing `src/autoresearch/python-tool.ts` and `src/rlm/notebook.ts`
 * (no new kernel, no new notebook implementation).
 *
 * Every python call made through the mission tool is recorded as a notebook
 * cell in `<cwd>/.gjc/_session-{id}/autoresearch/runs/<rlm-session>/notebook.ipynb`,
 * and the notebook survives mission restarts by resuming from the persisted
 * document.
 */
import * as path from "node:path";
import {
	ensureRlmSessionDir,
	isValidRlmSessionId,
	readRlmNotebookIfPresent,
	resolveRlmArtifactPaths,
} from "../rlm/artifacts";
import { RlmNotebookWriter } from "../rlm/notebook";
import type { RlmArtifactPaths } from "../rlm/types";
import { createAutoresearchPythonTool } from "./python-tool";

export interface AutoresearchMissionIdentity {
	slug: string;
}

/**
 * Derive the RLM artifact session id from a mission slug. The artifact layout
 * requires a filesystem-safe `[A-Za-z0-9_-]` segment, so dots are collapsed.
 * Mission writes reject unsafe slugs, which makes this identity stable across
 * reopen rather than silently generating a new artifact directory.
 */
export function missionRlmSessionId(mission: AutoresearchMissionIdentity): string {
	const sanitized = mission.slug
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 128);
	if (!isValidRlmSessionId(sanitized)) {
		throw new Error(`autoresearch mission slug cannot resolve to a stable artifact identity: ${mission.slug}`);
	}
	return sanitized;
}

/** Artifact paths for a mission's notebook/report/metadata. */
export function resolveMissionArtifactPaths(cwd: string, mission: AutoresearchMissionIdentity): RlmArtifactPaths {
	return resolveRlmArtifactPaths(cwd, missionRlmSessionId(mission));
}

export interface MissionNotebookHandle {
	writer: RlmNotebookWriter;
	paths: RlmArtifactPaths;
}

/** Open (creating if needed) the live notebook for a mission, resuming any persisted document. */
export async function openMissionNotebook(
	cwd: string,
	mission: AutoresearchMissionIdentity,
): Promise<MissionNotebookHandle> {
	const paths = resolveMissionArtifactPaths(cwd, mission);
	await ensureRlmSessionDir(paths);
	const existing = await readRlmNotebookIfPresent(cwd, missionRlmSessionId(mission));
	return {
		writer: new RlmNotebookWriter(paths.notebookPath, existing),
		paths,
	};
}

export interface MissionPythonToolInput {
	cwd: string;
	mission: AutoresearchMissionIdentity;
	/** Effective artifacts directory for kernel execution. */
	artifactsDir: string;
	/** Live notebook writer that records every executed cell. */
	notebook: RlmNotebookWriter;
	/** Registers a cleanup with the session disposal path (reaps the mission kernel). */
	registerSessionCleanup: (cleanup: () => Promise<void> | void) => void;
	/** Provision a managed workspace venv seeded with research packages. */
	managedWorkspaceVenv?: boolean;
}

/**
 * Build the mission `python` tool bound to a persisted mission. `getMissionId`
 * resolves to the mission slug for the whole tool lifetime, so the kernel
 * owner (`autoresearch:<slug>`) is distinct from the session eval owner.
 */
export function createMissionPythonTool(input: MissionPythonToolInput) {
	return createAutoresearchPythonTool({
		cwd: input.cwd,
		artifactsDir: input.artifactsDir,
		notebook: input.notebook,
		getMissionId: () => input.mission.slug,
		registerSessionCleanup: input.registerSessionCleanup,
		managedWorkspaceVenv: input.managedWorkspaceVenv,
	});
}

/** Default artifacts directory used when a mission session has no explicit one. */
export function missionArtifactsDir(cwd: string, mission: AutoresearchMissionIdentity): string {
	return path.join(resolveMissionArtifactPaths(cwd, mission).dir, "artifacts");
}
