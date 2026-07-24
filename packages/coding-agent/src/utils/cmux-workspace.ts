import { logger } from "@gajae-code/utils";

const CMUX_COMMAND = "cmux";
const CMUX_WORKSPACE_ID_ENV = "CMUX_WORKSPACE_ID";
const CMUX_NO_RENAME_ENV = "GJC_NO_CMUX_RENAME";
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const CMUX_SURFACE_ID_ENV = "CMUX_SURFACE_ID";
const CMUX_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CMUX_WORKSPACE_TITLE_PREFIX = "GJC: ";
const CMUX_WORKSPACE_RENAME_TIMEOUT_MS = 1500;
const CMUX_WORKSPACE_LIST_TIMEOUT_MS = 1500;

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
	kill(): void;
	unref(): void;
}

export interface CmuxWorkspaceTitleSyncOptions {
	env?: NodeJS.ProcessEnv;
	isTty?: boolean;
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
/** Returns a cmux identifier only when it is safe to pass as one argv element. */
export function getCmuxEnvironmentIdentifier(
	env: NodeJS.ProcessEnv,
	name: typeof CMUX_WORKSPACE_ID_ENV | typeof CMUX_SURFACE_ID_ENV,
): string | null {
	const value = env[name]?.trim();
	return value && CMUX_IDENTIFIER_PATTERN.test(value) ? value : null;
}

/** Removes controls and caps text shown in cmux-managed presentation surfaces. */
export function sanitizeCmuxDisplayText(value: string | undefined, maxLength = 512): string {
	if (!value) return "";
	return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, Math.max(0, maxLength));
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

/** Only rename when GJC owns the name:
 * - unknown ownership (read failed) → skip (fail safe, never clobber)
 * - already the desired title → skip (no-op)
 * - workspace still on its default title → rename
 * - any custom title (user- or peer-set) → skip
 * This makes GJC name a fresh workspace once and then leave it alone, so it
 * never overwrites a user-pinned name and multiple sessions sharing one
 * CMUX_WORKSPACE_ID do not thrash the workspace title. */
export function shouldRenameCmuxWorkspace(ownership: CmuxWorkspaceOwnership | null, desiredTitle: string): boolean {
	if (!ownership) return false;
	if ((sanitizeCmuxWorkspaceTitle(ownership.title) ?? "") === desiredTitle) return false;
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

/**
 * Best-effort sync of the containing cmux workspace title to the current GJC
 * session name. Ownership-guarded: GJC reads the current workspace title and
 * only renames a workspace that still has its default title, so it never
 * overwrites a name the user pinned or a name a peer session (sharing the same
 * CMUX_WORKSPACE_ID) set. Opt out with GJC_NO_CMUX_RENAME.
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

	let ownership: CmuxWorkspaceOwnership | null;
	try {
		const readOwnership = options.readOwnership ?? defaultReadOwnership;
		ownership = await readOwnership(resolvedCommand, workspaceId, env);
	} catch (error) {
		logger.debug("cmux workspace ownership read failed", { error: String(error) });
		return;
	}

	if (!shouldRenameCmuxWorkspace(ownership, desired)) return;

	const plan = buildCmuxWorkspaceRenameCommand(sessionName, env);
	if (!plan) return;

	const spawn = options.spawn ?? defaultSpawn;
	try {
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
		void proc.exited
			.then(exitCode => {
				clearTimeout(timer);
				if (exitCode !== 0) logger.debug("cmux workspace rename exited non-zero", { exitCode });
			})
			.catch(error => {
				clearTimeout(timer);
				logger.debug("cmux workspace rename failed", { error: String(error) });
			});
	} catch (error) {
		logger.debug("cmux workspace rename failed to start", { error: String(error) });
	}
}
