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

import * as crypto from "node:crypto";
import * as path from "node:path";
import { resolveGjcSessionForWrite } from "../gjc-runtime/session-resolution";
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
export function missionRlmSessionId(mission: AutoresearchMissionIdentity, sessionId?: string): string {
	const sanitized = mission.slug
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 128);
	if (!isValidRlmSessionId(sanitized)) {
		throw new Error(`autoresearch mission slug cannot resolve to a stable artifact identity: ${mission.slug}`);
	}
	const sessionPrefix = sessionId ? crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16) : "";
	const scoped = sessionPrefix ? `${sessionPrefix}-${sanitized.slice(0, 111)}` : sanitized;
	if (!isValidRlmSessionId(scoped)) {
		throw new Error(`autoresearch mission session cannot resolve to a stable artifact identity: ${sessionId}`);
	}
	return scoped;
}

/** Artifact paths for a mission's notebook/report/metadata. */
export function resolveMissionArtifactPaths(
	cwd: string,
	mission: AutoresearchMissionIdentity,
	sessionId?: string,
): RlmArtifactPaths {
	const resolvedSessionId =
		sessionId ?? resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	return resolveRlmArtifactPaths(cwd, missionRlmSessionId(mission, resolvedSessionId), resolvedSessionId);
}

export interface MissionNotebookHandle {
	writer: RlmNotebookWriter;
	paths: RlmArtifactPaths;
}

/** Open (creating if needed) the live notebook for a mission, resuming any persisted document. */
export async function openMissionNotebook(
	cwd: string,
	mission: AutoresearchMissionIdentity,
	sessionId?: string,
): Promise<MissionNotebookHandle> {
	const resolvedSessionId =
		sessionId ?? resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const paths = resolveMissionArtifactPaths(cwd, mission, resolvedSessionId);
	await ensureRlmSessionDir(paths);
	const existing = await readRlmNotebookIfPresent(
		cwd,
		missionRlmSessionId(mission, resolvedSessionId),
		resolvedSessionId,
	);
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
	sessionId?: string;
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
		getMissionId: () =>
			`${input.sessionId ?? resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId}:${input.mission.slug}`,
		registerSessionCleanup: input.registerSessionCleanup,
		managedWorkspaceVenv: input.managedWorkspaceVenv,
	});
}

/** Default artifacts directory used when a mission session has no explicit one. */
export function missionArtifactsDir(cwd: string, mission: AutoresearchMissionIdentity, sessionId?: string): string {
	return path.join(resolveMissionArtifactPaths(cwd, mission, sessionId).dir, "artifacts");
}
