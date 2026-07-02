import { logger } from "@gajae-code/utils";

const CMUX_COMMAND = "cmux";
const CMUX_WORKSPACE_ID_ENV = "CMUX_WORKSPACE_ID";
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const CMUX_WORKSPACE_TITLE_PREFIX = "GJC: ";
const CMUX_WORKSPACE_RENAME_TIMEOUT_MS = 1500;

export interface CmuxWorkspaceRenameCommand {
	command: string;
	args: string[];
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
}

function defaultSpawn(
	command: string[],
	options: { env: NodeJS.ProcessEnv; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
): CmuxWorkspaceRenameProcess {
	return Bun.spawn(command, options);
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

export function syncCmuxWorkspaceTitle(
	sessionName: string | undefined,
	options: CmuxWorkspaceTitleSyncOptions = {},
): void {
	const isTty = options.isTty ?? process.stdout.isTTY === true;
	if (!isTty) return;

	const env = options.env ?? process.env;
	const plan = buildCmuxWorkspaceRenameCommand(sessionName, env);
	if (!plan) return;

	const which = options.which ?? Bun.which;
	let resolvedCommand: string | null;
	try {
		resolvedCommand = which(plan.command);
	} catch (error) {
		logger.debug("cmux workspace rename command lookup failed", { error: String(error) });
		return;
	}
	if (!resolvedCommand) return;

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
