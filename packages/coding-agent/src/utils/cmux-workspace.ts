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
const CMUX_WORKSPACE_LOCK_DIR_MODE = 0o700;
const CMUX_WORKSPACE_LOCK_FILE_MODE_MASK = 0o077;
const processClaims = new Map<string, string>();
const MAX_PROCESS_CLAIMS = 32;

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

export interface CmuxWorkspaceRenameProcess {
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
	unref(): void;
}

export interface CmuxWorkspaceTitleSyncOptions {
	env?: NodeJS.ProcessEnv;
	isTty?: boolean;
	lockDir?: string;
	claims?: Map<string, string>;
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
async function withProcessDeadline<T>(
	proc: Pick<CmuxWorkspaceRenameProcess, "kill">,
	operation: Promise<T>,
	timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	const timeout = Promise.withResolvers<{ timedOut: true }>();
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {}
		timeout.resolve({ timedOut: true });
	}, timeoutMs);
	timer.unref?.();
	try {
		return await Promise.race([operation.then(value => ({ timedOut: false as const, value })), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
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

/** Decide whether this process may rename the workspace.
 * A default-titled workspace may be claimed. Once claimed, updates require the
 * current title to exactly match the last title this process verified after a
 * successful rename. A prefix is never ownership evidence. */
export function shouldRenameCmuxWorkspace(
	ownership: CmuxWorkspaceOwnership | null,
	desiredTitle: string,
	lastVerifiedTitle?: string,
): boolean {
	if (!ownership) return false;
	const currentTitle = ownership.title;
	if (currentTitle === desiredTitle) return false;
	if (lastVerifiedTitle !== undefined) return ownership.hasCustomTitle && currentTitle === lastVerifiedTitle;
	return !ownership.hasCustomTitle;
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
		const completed = await withProcessDeadline(
			proc,
			(async () => {
				const text = await new Response(proc.stdout).text();
				const exitCode = await proc.exited;
				return { exitCode, text };
			})(),
			CMUX_WORKSPACE_LIST_TIMEOUT_MS,
		);
		if (completed.timedOut) {
			logger.debug("cmux workspace list timed out");
			return null;
		}
		if (completed.value.exitCode !== 0) {
			logger.debug("cmux workspace list exited non-zero", { exitCode: completed.value.exitCode });
			return null;
		}
		return parseCmuxWorkspaceOwnership(completed.value.text, workspaceId);
	} catch (error) {
		logger.debug("cmux workspace list failed", { error: String(error) });
		return null;
	}
}
function claimKey(workspaceId: string, env: NodeJS.ProcessEnv): string {
	const socket = env.CMUX_SOCKET_PATH?.trim() || env.CMUX_SOCKET?.trim() || "default";
	return `${socket}\u0000${workspaceId.trim().toLowerCase()}`;
}

function workspaceLockFile(lockDir: string, key: string): string {
	return path.join(lockDir, `${crypto.createHash("sha256").update(key).digest("hex")}.guard`);
}
function rememberClaim(claims: Map<string, string>, key: string, title: string): void {
	claims.delete(key);
	claims.set(key, title);
	while (claims.size > MAX_PROCESS_CLAIMS) {
		const oldest = claims.keys().next().value;
		if (oldest === undefined) return;
		claims.delete(oldest);
	}
}

async function assertOwnedCanonicalDirectory(directory: string, privateMode: boolean): Promise<string> {
	const resolved = path.resolve(directory);
	const [stat, canonical] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)]);
	if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolved)
		throw new Error("cmux workspace lock path is not a canonical directory");
	if (typeof process.getuid === "function" && stat.uid !== process.getuid())
		throw new Error("cmux workspace lock path is not owned by the current user");
	if (privateMode && (stat.mode & CMUX_WORKSPACE_LOCK_FILE_MODE_MASK) !== 0)
		await fs.chmod(resolved, CMUX_WORKSPACE_LOCK_DIR_MODE);
	return resolved;
}

async function ensureOwnedChildDirectory(parent: string, name: string, privateMode: boolean): Promise<string> {
	const canonicalParent = await assertOwnedCanonicalDirectory(parent, false);
	const child = path.join(canonicalParent, name);
	try {
		await fs.mkdir(child, { mode: privateMode ? CMUX_WORKSPACE_LOCK_DIR_MODE : 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return assertOwnedCanonicalDirectory(child, privateMode);
}

async function ensurePrivateLockDir(configuredLockDir?: string): Promise<string> {
	if (configuredLockDir) {
		const resolved = path.resolve(configuredLockDir);
		return ensureOwnedChildDirectory(path.dirname(resolved), path.basename(resolved), true);
	}
	const agentDir = await assertOwnedCanonicalDirectory(await fs.realpath(getAgentDir()), false);
	const stateDir = await ensureOwnedChildDirectory(agentDir, "state", false);
	return ensureOwnedChildDirectory(stateDir, "cmux-workspace-locks", true);
}

async function renameAndVerify(
	resolvedCommand: string,
	workspaceId: string,
	sessionName: string | undefined,
	desired: string,
	env: NodeJS.ProcessEnv,
	readOwnership: NonNullable<CmuxWorkspaceTitleSyncOptions["readOwnership"]>,
	spawn: NonNullable<CmuxWorkspaceTitleSyncOptions["spawn"]>,
): Promise<boolean> {
	const plan = buildCmuxWorkspaceRenameCommand(sessionName, env);
	if (!plan) return false;

	const proc = spawn([resolvedCommand, ...plan.args], {
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	proc.unref();
	const completed = await withProcessDeadline(proc, proc.exited, CMUX_WORKSPACE_RENAME_TIMEOUT_MS);
	if (completed.timedOut) {
		logger.debug("cmux workspace rename timed out");
		return false;
	}
	if (completed.value !== 0) {
		logger.debug("cmux workspace rename exited non-zero", { exitCode: completed.value });
		return false;
	}
	const verified = await readOwnership(resolvedCommand, workspaceId, env);
	return verified?.hasCustomTitle === true && verified.title === desired;
}

/**
 * Best-effort sync of the containing cmux workspace title to the current GJC
 * process. Claims are process-lifetime only: a successful rename is read back,
 * and subsequent updates require the exact last verified title. A guarded
 * cross-process claim prevents peer GJC processes from simultaneously claiming
 * a fresh workspace. User or peer changes revoke this process's claim.
 */
export async function syncCmuxWorkspaceTitle(
	sessionName: string | undefined,
	options: CmuxWorkspaceTitleSyncOptions = {},
): Promise<void> {
	const env = options.env ?? process.env;
	if (isEnvSet(env[CMUX_NO_RENAME_ENV])) return;

	const isTty = options.isTty ?? process.stdout.isTTY === true;
	if (!isTty) return;

	const workspaceId = env[CMUX_WORKSPACE_ID_ENV]?.trim();
	if (!workspaceId) return;

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

	const key = claimKey(workspaceId, env);
	const claims = options.claims ?? processClaims;
	const readOwnership = options.readOwnership ?? defaultReadOwnership;
	const spawn = options.spawn ?? defaultSpawn;
	const configuredLockDir = options.lockDir;

	try {
		const lockDir = await ensurePrivateLockDir(configuredLockDir);
		await withFileLock(workspaceLockFile(lockDir, key), async () => {
			const ownership = await readOwnership(resolvedCommand, workspaceId, env);
			const lastVerifiedTitle = claims.get(key);
			if (lastVerifiedTitle !== undefined && ownership?.title !== lastVerifiedTitle) {
				claims.delete(key);
				return;
			}
			if (!shouldRenameCmuxWorkspace(ownership, desired, lastVerifiedTitle)) return;

			if (await renameAndVerify(resolvedCommand, workspaceId, sessionName, desired, env, readOwnership, spawn))
				rememberClaim(claims, key, desired);
			else claims.delete(key);
		});
	} catch (error) {
		logger.debug("cmux workspace title sync failed", { error: String(error) });
	}
}
