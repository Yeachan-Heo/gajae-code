import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeDisplayLine, sanitizeText } from "@gajae-code/utils";
import { type ExecOptions, type ExecResult, execCommand } from "../../exec/exec";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

/**
 * Aside CLI discovery and `/aside` dispatch.
 *
 * Probe-only: never runs the installer. Missing-CLI handling is the caller's
 * decision. This is an explicit composer frontend, not a GJC browser backend.
 */

export const ASIDE_INSTALL_URL = "https://releases.aside.com/install.sh";
export const ASIDE_INSTALL_COMMAND = "curl -fsSL https://releases.aside.com/install.sh | bash";

const ASIDE_HELP_VERBS = new Set(["help", "-h", "--help"]);

const ASIDE_STATUS_TIMEOUT_MS = 15_000;
const ASIDE_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

export const ASIDE_USAGE = [
	"Aside CLI (explicit opt-in; does not enable GJC browser-control by default)",
	"  /aside                         Show CLI path and usage",
	"  /aside <prompt>                Run `aside exec <prompt>`",
	"  /aside exec [args]             Pass argv through to `aside exec`",
	"  /aside repl                    Not available inside GJC; run `aside repl` in a terminal",
	"  /aside mcp                     Print MCP registration using the resolved CLI path",
	"  /aside account [args]          Run `aside account` (list/status/use)",
	"  /aside help                    Show this help",
].join("\n");

export type AsideCliProbe =
	| { ok: true; path: string }
	| { ok: false; searched: string[]; manualInstallCommand: string; url: string };

export type AsideWhich = (command: string) => string | null | undefined;
export type AsideIsExecutable = (filePath: string) => boolean;
export type AsideExec = (command: string, args: string[], cwd: string, options?: ExecOptions) => Promise<ExecResult>;

export interface AsideHandlerOptions {
	homedir?: () => string;
	which?: AsideWhich;
	isExecutable?: AsideIsExecutable;
	exec?: AsideExec;
}

/** Candidate absolute paths for the `aside` CLI, in priority order. */
export function asideCliCandidates(home = os.homedir()): string[] {
	return [
		path.join(home, ".local", "bin", "aside"),
		path.join(home, ".aside", "cli", "Aside CLI.app", "Contents", "MacOS", "aside"),
	];
}

function defaultIsExecutable(filePath: string): boolean {
	try {
		const st = fs.statSync(filePath);
		if (!st.isFile()) return false;
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function defaultWhich(command: string): string | null {
	return Bun.which(command) ?? null;
}

function isSafeAsideCliPath(value: string): boolean {
	return sanitizeText(value) === value && !/[\r\n]/u.test(value);
}

/** Resolve the first executable Aside CLI path, or null when none is found. */
export function resolveAsideCliPath(
	home = os.homedir(),
	options: Pick<AsideHandlerOptions, "which" | "isExecutable"> = {},
): string | null {
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const which = options.which ?? defaultWhich;
	for (const candidate of asideCliCandidates(home)) {
		if (isExecutable(candidate) && isSafeAsideCliPath(candidate)) return candidate;
	}
	const fromPath = which("aside");
	if (fromPath && isExecutable(fromPath) && isSafeAsideCliPath(fromPath)) return fromPath;
	return null;
}

/** Structured probe result for callers that need to guide installation. */
export function probeAsideCli(
	home = os.homedir(),
	options: Pick<AsideHandlerOptions, "which" | "isExecutable"> = {},
): AsideCliProbe {
	const searched = [...asideCliCandidates(home), "PATH (aside)"];
	const found = resolveAsideCliPath(home, options);
	if (found) return { ok: true, path: found };
	return { ok: false, searched, manualInstallCommand: ASIDE_INSTALL_COMMAND, url: ASIDE_INSTALL_URL };
}

export function posixQuote(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a path for the PowerShell command shown on native Windows. */
export function windowsPowerShellQuote(value: string): string {
	// PowerShell also treats U+2018 through U+201B as single quotes inside a single-quoted string.
	return `'${value.replace(/['\u2018-\u201B]/g, "$&$&")}'`;
}

function quoteAsidePath(value: string, platform = process.platform): string {
	return platform === "win32" ? windowsPowerShellQuote(value) : posixQuote(value);
}

type AsideArgvResult = { ok: true; args: string[] } | { ok: false; error: string };

/** Parse user-provided Aside argv without silently accepting malformed quoting. */
export function parseAsideArgv(input: string): AsideArgvResult {
	const args: string[] = [];
	let current = "";
	let tokenStarted = false;
	let quote: "'" | '"' | null = null;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			tokenStarted = true;
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = null;
			} else if (char === "\\" && quote === '"') {
				escaped = true;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
		} else if (char === "\\") {
			escaped = true;
			tokenStarted = true;
		} else if (char === " " || char === "\t") {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
		} else {
			current += char;
			tokenStarted = true;
		}
	}

	if (escaped) return { ok: false, error: "unfinished escape" };
	if (quote) return { ok: false, error: "unterminated quote" };
	if (tokenStarted) args.push(current);
	return { ok: true, args };
}

export function formatAsideMissingCli(probe: Extract<AsideCliProbe, { ok: false }>): string {
	const installLabel = process.platform === "win32" ? "Install with in WSL or Git Bash:" : "Install with:";
	return [
		"Aside CLI was not found.",
		"Looked in:",
		...probe.searched.map(entry => `  - ${entry}`),
		installLabel,
		`  ${probe.manualInstallCommand}`,
		`Docs: ${probe.url}`,
		"Then retry /aside, or register MCP with the concrete binary path.",
	].join("\n");
}

export function formatAsideMcpRegistration(cliPath: string, platform = process.platform): string {
	const safeCliPath = sanitizeText(cliPath).replace(/[\r\n]/gu, " ");
	const quotedCliPath = quoteAsidePath(safeCliPath, platform);
	return [
		`Aside CLI: ${safeCliPath}`,
		"`/aside mcp` does not start a stdio server inside GJC.",
		"Register the user-owned MCP definition with the resolved binary:",
		`  gjc mcp add aside ${quotedCliPath} mcp --project`,
		"Inspect the redacted record with `gjc mcp list --json`.",
		"Do not paste cookies, screenshots, or private Aside profile paths into issues or PRs.",
	].join("\n");
}

function formatExecOutput(result: ExecResult): string {
	const body = [sanitizeText(result.stdout).trim(), sanitizeText(result.stderr).trim()].filter(Boolean).join("\n");
	if (result.killed) {
		return body ? `${body}\nAside CLI timed out or was cancelled.` : "Aside CLI timed out or was cancelled.";
	}
	if (!body) {
		return result.code === 0
			? "Aside CLI exited 0 with no output."
			: `Aside CLI exited ${result.code} with no output.`;
	}
	if (result.code !== 0) return `${body}\n(exit ${result.code})`;
	return body;
}

export function createAsideHandler(options: AsideHandlerOptions = {}) {
	const homedir = options.homedir ?? os.homedir;
	const exec = options.exec ?? execCommand;
	const probeOptions = { which: options.which, isExecutable: options.isExecutable };

	async function runCli(
		runtime: SlashCommandRuntime,
		cliPath: string,
		args: string[],
		timeout: number,
	): Promise<SlashCommandResult> {
		try {
			const result = await exec(cliPath, args, runtime.cwd, { timeout });
			await runtime.output(formatExecOutput(result));
			return result.code === 0 && !result.killed
				? commandConsumed()
				: { consumed: true, exitCode: result.code || 1 };
		} catch (error) {
			return usage(`Aside CLI failed: ${errorMessage(error)}`, runtime);
		}
	}

	return async function handleAsideAcp(
		command: ParsedSlashCommand,
		runtime: SlashCommandRuntime,
	): Promise<SlashCommandResult> {
		const { verb, rest } = parseSubcommand(command.args);
		if (ASIDE_HELP_VERBS.has(verb)) return usage(ASIDE_USAGE, runtime);

		const probe = probeAsideCli(homedir(), probeOptions);

		if (verb === "mcp") {
			if (rest) return usage("Usage: /aside mcp", runtime);
			if (!probe.ok) return usage(formatAsideMissingCli(probe), runtime);
			return usage(formatAsideMcpRegistration(probe.path), runtime);
		}

		if (verb === "repl") {
			if (rest) return usage("Usage: /aside repl", runtime);
			if (!probe.ok) return usage(formatAsideMissingCli(probe), runtime);
			return usage(
				[
					"`/aside repl` needs a real terminal TTY.",
					`Run this outside GJC: ${quoteAsidePath(probe.path)} repl`,
				].join("\n"),
				runtime,
			);
		}

		if (!verb) {
			if (!probe.ok) return usage(`${formatAsideMissingCli(probe)}\n\n${ASIDE_USAGE}`, runtime);
			const lines = [`Aside CLI: ${probe.path}`];
			try {
				const version = await exec(probe.path, ["--version"], runtime.cwd, { timeout: ASIDE_STATUS_TIMEOUT_MS });
				const label = sanitizeDisplayLine(version.stdout).trim() || sanitizeDisplayLine(version.stderr).trim();
				if (version.code === 0 && label) lines.push(`Version: ${label.split("\n")[0]}`);
			} catch {
				// Status should still print when `--version` is unavailable.
			}
			lines.push(ASIDE_USAGE);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		}

		if (!probe.ok) return usage(formatAsideMissingCli(probe), runtime);

		if (verb === "account") {
			const parsed = parseAsideArgv(rest);
			if (!parsed.ok) return usage(`Invalid Aside arguments: ${parsed.error}.`, runtime);
			return runCli(runtime, probe.path, ["account", ...parsed.args], ASIDE_STATUS_TIMEOUT_MS);
		}

		if (verb === "exec") {
			const parsed = parseAsideArgv(rest);
			if (!parsed.ok) return usage(`Invalid Aside arguments: ${parsed.error}.`, runtime);
			const argv = parsed.args;
			if (argv.length === 0) return usage("Usage: /aside exec [args] <prompt>", runtime);
			return runCli(runtime, probe.path, ["exec", ...argv], ASIDE_EXEC_TIMEOUT_MS);
		}

		if (verb.startsWith("-")) {
			const parsed = parseAsideArgv(command.args);
			if (!parsed.ok) return usage(`Invalid Aside arguments: ${parsed.error}.`, runtime);
			return runCli(runtime, probe.path, ["exec", ...parsed.args], ASIDE_EXEC_TIMEOUT_MS);
		}

		return runCli(runtime, probe.path, ["exec", command.args.trim()], ASIDE_EXEC_TIMEOUT_MS);
	};
}

export const handleAsideAcp = createAsideHandler();
