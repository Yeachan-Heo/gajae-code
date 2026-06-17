/**
 * RLM session artifact layout under <cwd>/.gjc/rlm/<sessionId>/.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readNotebookDocument } from "../edit/notebook";
import type { RlmArtifactPaths } from "./types";

export const RLM_DIR_SEGMENT = path.join(".gjc", "rlm");

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidRlmSessionId(sessionId: string): boolean {
	return sessionId.length > 0 && sessionId.length <= 128 && SESSION_ID_RE.test(sessionId);
}

/** Generate a filesystem-safe, sortable session id (timestamp + random suffix). */
export function generateRlmSessionId(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

export function resolveRlmArtifactPaths(cwd: string, sessionId: string): RlmArtifactPaths {
	if (!isValidRlmSessionId(sessionId)) {
		throw new Error(`Invalid RLM session id: ${JSON.stringify(sessionId)}`);
	}
	const dir = path.join(cwd, RLM_DIR_SEGMENT, sessionId);
	return {
		dir,
		notebookPath: path.join(dir, "notebook.ipynb"),
		reportPath: path.join(dir, "report.md"),
		metadataPath: path.join(dir, "metadata.json"),
		agentSessionDir: path.join(dir, "agent-session"),
	};
}

export async function ensureRlmSessionDir(paths: RlmArtifactPaths): Promise<void> {
	await fs.mkdir(paths.dir, { recursive: true });
}

export async function rlmSessionExists(cwd: string, sessionId: string): Promise<boolean> {
	const paths = resolveRlmArtifactPaths(cwd, sessionId);
	try {
		const stat = await fs.stat(paths.dir);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

export async function readRlmNotebookIfPresent(cwd: string, sessionId: string) {
	const paths = resolveRlmArtifactPaths(cwd, sessionId);
	try {
		return await readNotebookDocument(paths.notebookPath, paths.notebookPath);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("File not found:")) return undefined;
		throw error;
	}
}
