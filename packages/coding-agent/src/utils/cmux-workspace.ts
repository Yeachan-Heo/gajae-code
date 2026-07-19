import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, logger } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";

const CMUX_COMMAND = "cmux";
const CMUX_WORKSPACE_ID_ENV = "CMUX_WORKSPACE_ID";
const CMUX_NO_RENAME_ENV = "GJC_NO_CMUX_RENAME";
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const CMUX_WORKSPACE_TITLE_PREFIX = "GJC: ";
const CMUX_WORKSPACE_RENAME_TIMEOUT_MS = 1500;
const CMUX_WORKSPACE_LIST_TIMEOUT_MS = 1500;
const CMUX_WORKSPACE_STATE_SCHEMA_VERSION = 1;

export interface CmuxWorkspaceRenameCommand {
	command: string;
	args: string[];
}

/** Current ownership state of a cmux workspace, read back from `cmux workspace list`. */
export interface CmuxWorkspaceOwnership {
	/** cmux marks a workspace `has_custom_title` once an explicit title is set (by the user or by GJC). */
	hasCustomTitle: boolean;
	/** The workspace's current display title. */
	title: string;
}

export interface CmuxWorkspaceManagedOwnership {
	schemaVersion: 1;
	sessionId: string;
	title: string;
}

export interface CmuxWorkspaceRenameProcess {
	exited: Promise<number>;
	kill(): void;
	unref(): void;
}

export interface CmuxWorkspaceTitleSyncOptions {
	env?: NodeJS.ProcessEnv;
	isTty?: boolean;
	stateDir?: string;
	which?: (command: string) => string | null;
	spawn?: (
		command: string[],
		options: { env: NodeJS.ProcessEnv; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
	) => CmuxWorkspaceRenameProcess;
	/** Reads the current ownership state of `workspaceId`. Injectable for tests. */
	readOwnership?: (
		cmuxCommand: string,
		workspaceId: string,
		env: NodeJS.ProcessEnv,
	) => Promise<CmuxWorkspaceOwnership | null>;
}

function defaultSpawn(
	command: string[],
	options: { env: NodeJS.ProcessEnv; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
): CmuxWorkspaceRenameProcess {
	return Bun.spawn(command, options);
}

function isEnvSet(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export function sanitizeCmuxWorkspaceTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	const sanitized = title.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	return sanitized || undefined;
}

export function formatCmuxWorkspaceTitle(title: string | undefined): string | undefined {
	const sanitized = sanitizeCmuxWorkspaceTitle(title);
	if (!sanitized) return undefined;
	return sanitized.startsWith(CMUX_WORKSPACE_TITLE_PREFIX) ? sanitized : `${CMUX_WORKSPACE_TITLE_PREFIX}${sanitized}`;
}

export function buildCmuxWorkspaceRenameCommand(
	sessionName: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CmuxWorkspaceRenameCommand | null {
	const workspaceId = env[CMUX_WORKSPACE_ID_ENV]?.trim();
	if (!workspaceId) return null;

	const title = formatCmuxWorkspaceTitle(sessionName);
	if (!title) return null;

	return {
		command: CMUX_COMMAND,
		args: ["workspace", "rename", workspaceId, "--title", title],
	};
}

/** Parse `cmux workspace list --json --id-format both` output and return the
 * ownership state of the workspace matching `workspaceId` (by UUID `id` or `ref`). */
export function parseCmuxWorkspaceOwnership(jsonText: string, workspaceId: string): CmuxWorkspaceOwnership | null {
	const target = workspaceId.trim().toLowerCase();
	if (!target) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}

	const workspaces = (parsed as { workspaces?: unknown }).workspaces;
	if (!Array.isArray(workspaces)) return null;

	for (const entry of workspaces) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.toLowerCase() : "";
		const ref = typeof record.ref === "string" ? record.ref.toLowerCase() : "";
		if (id !== target && ref !== target) continue;
		return {
			hasCustomTitle: record.has_custom_title === true,
			title: typeof record.title === "string" ? record.title : "",
		};
	}
	return null;
}

/** Only rename when the current session has durable ownership evidence:
 * - unknown ownership (read failed) → skip (fail safe, never clobber)
 * - already the desired title → skip (no-op)
 * - workspace still on its default title → rename and claim it
 * - custom title matching this session's last successful rename → rename
 * - any other custom title → skip
 * The durable record distinguishes the owning session from peer GJC processes
 * and user-pinned titles; a display prefix alone is never ownership proof. */
export function shouldRenameCmuxWorkspace(
	ownership: CmuxWorkspaceOwnership | null,
	desiredTitle: string,
	managedOwnership: CmuxWorkspaceManagedOwnership | null,
	sessionId: string,
): boolean {
	if (!ownership) return false;
	const currentTitle = sanitizeCmuxWorkspaceTitle(ownership.title) ?? "";
	if (currentTitle === desiredTitle) return false;
	if (!ownership.hasCustomTitle) return true;
	return managedOwnership?.sessionId === sessionId && managedOwnership.title === currentTitle;
}

async function defaultReadOwnership(
	cmuxCommand: string,
	workspaceId: string,
	env: NodeJS.ProcessEnv,
): Promise<CmuxWorkspaceOwnership | null> {
	try {
		const proc = Bun.spawn([cmuxCommand, "workspace", "list", "--json", "--id-format", "both"], {
			env: { ...env, CMUX_QUIET: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, CMUX_WORKSPACE_LIST_TIMEOUT_MS);
		timer.unref?.();
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		clearTimeout(timer);
		return parseCmuxWorkspaceOwnership(text, workspaceId);
	} catch (error) {
		logger.debug("cmux workspace list failed", { error: String(error) });
		return null;
	}
}
function workspaceStateFile(workspaceId: string, stateDir: string): string {
	const key = crypto.createHash("sha256").update(workspaceId.trim().toLowerCase()).digest("hex");
	return path.join(stateDir, `${key}.json`);
}

async function readManagedOwnership(stateFile: string): Promise<CmuxWorkspaceManagedOwnership | null> {
	try {
		const parsed = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
		const sessionId = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
		const title = sanitizeCmuxWorkspaceTitle(typeof parsed.title === "string" ? parsed.title : undefined);
		if (parsed.schema_version !== CMUX_WORKSPACE_STATE_SCHEMA_VERSION || !sessionId || !title) return null;
		return { schemaVersion: 1, sessionId, title };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			logger.debug("cmux workspace managed ownership read failed", { error: String(error) });
		return null;
	}
}

async function writeManagedOwnership(stateFile: string, ownership: CmuxWorkspaceManagedOwnership): Promise<void> {
	const temporary = `${stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await Bun.write(
		temporary,
		`${JSON.stringify({
			schema_version: ownership.schemaVersion,
			session_id: ownership.sessionId,
			title: ownership.title,
		})}\n`,
	);
	await fs.chmod(temporary, 0o600);
	try {
		await fs.rename(temporary, stateFile);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

/**
 * Best-effort sync of the containing cmux workspace title to the current GJC
 * session name. A cross-process lock and durable session/title record serialize
 * peer GJC writers and preserve unrelated custom titles. Opt out with
 * GJC_NO_CMUX_RENAME.
 */
export async function syncCmuxWorkspaceTitle(
	sessionName: string | undefined,
	sessionId: string | undefined,
	options: CmuxWorkspaceTitleSyncOptions = {},
): Promise<void> {
	const env = options.env ?? process.env;
	if (isEnvSet(env[CMUX_NO_RENAME_ENV])) return;

	const isTty = options.isTty ?? process.stdout.isTTY === true;
	if (!isTty) return;

	const workspaceId = env[CMUX_WORKSPACE_ID_ENV]?.trim();
	const normalizedSessionId = sessionId?.trim();
	if (!workspaceId || !normalizedSessionId) return;

	const desired = formatCmuxWorkspaceTitle(sessionName);
	if (!desired) return;

	const which = options.which ?? Bun.which;
	let resolvedCommand: string | null;
	try {
		resolvedCommand = which(CMUX_COMMAND);
	} catch (error) {
		logger.debug("cmux workspace rename command lookup failed", { error: String(error) });
		return;
	}
	if (!resolvedCommand) return;

	const stateDir = options.stateDir ?? path.join(getAgentDir(), "state", "cmux-workspaces");
	const stateFile = workspaceStateFile(workspaceId, stateDir);
	const readOwnership = options.readOwnership ?? defaultReadOwnership;
	const spawn = options.spawn ?? defaultSpawn;

	try {
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		await withFileLock(stateFile, async () => {
			const ownership = await readOwnership(resolvedCommand, workspaceId, env);
			const managedOwnership = await readManagedOwnership(stateFile);
			if (!shouldRenameCmuxWorkspace(ownership, desired, managedOwnership, normalizedSessionId)) return;

			const plan = buildCmuxWorkspaceRenameCommand(sessionName, env);
			if (!plan) return;

			const proc = spawn([resolvedCommand, ...plan.args], {
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			proc.unref();
			const timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {}
			}, CMUX_WORKSPACE_RENAME_TIMEOUT_MS);
			timer.unref?.();

			try {
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					logger.debug("cmux workspace rename exited non-zero", { exitCode });
					return;
				}
				await writeManagedOwnership(stateFile, {
					schemaVersion: 1,
					sessionId: normalizedSessionId,
					title: desired,
				});
			} finally {
				clearTimeout(timer);
			}
		});
	} catch (error) {
		logger.debug("cmux workspace title sync failed", { error: String(error) });
	}
}
