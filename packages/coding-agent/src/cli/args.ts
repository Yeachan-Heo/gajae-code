/**
 * CLI argument parsing
 */
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import { CliParseError } from "@gajae-code/utils/cli";
import { parseThinkingLevel } from "../thinking";
import { BUILTIN_TOOLS } from "../tools";
import {
	type ConsumerLaunchFlagName,
	LAUNCH_PARSE_FLAGS,
	launchFlagIsOwnedBy,
	ROOT_THINKING_LEVELS,
	type RootThinkingLevel,
} from "./root-flags";

const ROOT_FLAG_TOKENS = new Set<string>();
for (const [name, descriptor] of Object.entries(LAUNCH_PARSE_FLAGS)) {
	ROOT_FLAG_TOKENS.add(`--${name}`);
	if (descriptor.char) ROOT_FLAG_TOKENS.add(`-${descriptor.char}`);
}

const INTERNAL_ROOT_FLAG_TOKENS = new Set(["--help", "-h", "--version", "-v", "--session", "--provider-session-id"]);

function isExternallyParsedRootFlagToken(arg: string): boolean {
	return (
		arg === "--acp-terminal-auth" ||
		arg === "--worktree" ||
		arg === "-w" ||
		arg.startsWith("-w=") ||
		arg.startsWith("-w")
	);
}

function isKnownRootFlagToken(arg: string): boolean {
	return ROOT_FLAG_TOKENS.has(arg) || INTERNAL_ROOT_FLAG_TOKENS.has(arg) || isExternallyParsedRootFlagToken(arg);
}

export type Mode = "text" | "json" | "acp";

export type ParseArgsAuthority = "local" | "acp" | "deferred";

export interface Args {
	cwd?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	smol?: string;
	slow?: string;
	plan?: string;
	mpreset?: string;
	default?: boolean;
	apiKey?: string;
	credential?: string;
	preferCredential?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	clipboardTransport?: "auto" | "native" | "osc52" | "ssh";
	clipboardSshHost?: string;
	mcpConfig?: string;
	/** Opt a standalone session out of conventional MCP autoload (mutually exclusive with --mcp-config). */
	noMcp?: boolean;
	thinking?: RootThinkingLevel;
	continue?: boolean;
	resume?: string | true;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	fork?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noLsp?: boolean;
	noPty?: boolean;
	tmux?: boolean;
	/** Retained for runtime/test compatibility; extension loading flags are no longer parsed. */
	hooks?: string[];
	extensions?: string[];
	noExtensions?: boolean;
	pluginDirs?: string[];
	print?: boolean;
	export?: string;
	/** Retained for runtime/test compatibility; arbitrary skill discovery is always disabled. */
	noSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	listModels?: string | true;
	noTitle?: boolean;
	master?: true;
	masterScope?: "repo" | "pwd" | "global";
	messages: string[];
	fileArgs: string[];
	/** Flags unknown to every launch parser; their consumer supplies the diagnostic. */
	unknownFlags: Map<string, boolean | string>;
	/** Exact interactive startup login intent, recognized before model-profile activation. */
	authBootstrap?: true;
}

const CONSUMER_FLAGS_BY_ARGS = new WeakMap<Args, Map<ConsumerLaunchFlagName, string>>();

function isStartupSlashCommandArg(arg: string | undefined): boolean {
	return (
		arg === "/provider" ||
		arg?.startsWith("/provider:") === true ||
		arg === "/provicer" ||
		arg?.startsWith("/provicer:") === true
	);
}

function isStartupLoginCommandArg(args: readonly string[], index: number): boolean {
	const command = args[index];
	if (command !== "/login" && command !== "login") return false;
	const argumentCount = args.length - index - 1;
	return argumentCount === 0 || (argumentCount === 1 && !args[index + 1].startsWith("-"));
}

function takeFlagValue(args: readonly string[], index: number, flag: string, allowDashPrefixed = false): string {
	const value = args[index + 1];
	if (!value || (!allowDashPrefixed && value.startsWith("-"))) {
		throw new CliParseError(`${flag} requires a value`);
	}
	return value;
}

function takePromptValue(
	args: readonly string[],
	index: number,
	flag: string,
	allowInlineDashPrefixed: boolean,
): string {
	const value = args[index + 1];
	const allowSeparatedDashPrefixed = value === "-" || value?.startsWith("- ") === true;
	return takeFlagValue(args, index, flag, allowInlineDashPrefixed || allowSeparatedDashPrefixed);
}

export function parseArgs(args: string[], authority: ParseArgsAuthority = "local"): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
	};
	const consumerFlags = new Map<ConsumerLaunchFlagName, string>();
	let hasThinkingFlag = false;

	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		let hasInlineValue = false;

		if (isStartupLoginCommandArg(args, i)) {
			result.authBootstrap = true;
			const loginCommand = arg === "login" ? "/login" : arg;
			result.messages.push([loginCommand, ...args.slice(i + 1)].join(" "));
			break;
		}
		if (isStartupSlashCommandArg(arg)) {
			result.messages.push(args.slice(i).join(" "));
			break;
		}
		if (arg === "--") {
			for (const positional of args.slice(i + 1)) {
				if (positional.startsWith("@")) result.fileArgs.push(positional.slice(1));
				else result.messages.push(positional);
			}
			break;
		}

		// Support --flag=value syntax (e.g. --tools=ask,read)
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			hasInlineValue = true;
			// Insert the value so the existing "args[++i]" logic picks it up
			args.splice(i + 1, 0, value);
		}
		if (arg.startsWith("-") && !isKnownRootFlagToken(arg)) {
			result.unknownFlags.set(arg, true);
			if (hasInlineValue) i++;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--master") {
			result.master = true;
		} else if (arg === "--scope") {
			const scope = takeFlagValue(args, i++, "--scope");
			if (scope !== "repo" && scope !== "pwd" && scope !== "global") {
				throw new CliParseError("invalid --scope value (expected repo, pwd, or global)");
			}
			if (result.masterScope !== undefined && result.masterScope !== scope) {
				throw new CliParseError("--scope cannot be specified with conflicting values");
			}
			result.masterScope = scope;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--mode") {
			const mode = takeFlagValue(args, i, "--mode");
			i++;
			if (mode === "text" || mode === "json" || mode === "acp") {
				result.mode = mode;
			} else {
				const removed = mode === "rpc" || mode === "rpc-ui" || mode === "bridge";
				throw new CliParseError(
					removed
						? `--mode ${mode} was removed; external control now uses the Gajae-Code SDK (docs/sdk.md)`
						: `invalid --mode value: ${mode} (expected text, json, or acp)`,
				);
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r" || arg === "--session") {
			const next = args[i + 1];
			if (next && !next.startsWith("-")) {
				result.resume = args[++i];
			} else {
				result.resume = true;
			}
		} else if (arg === "--fork") {
			result.fork = takeFlagValue(args, i++, "--fork");
		} else if (arg === "--provider") {
			result.provider = takeFlagValue(args, i++, "--provider");
		} else if (arg === "--model") {
			result.model = takeFlagValue(args, i++, "--model");
		} else if (arg === "--smol") {
			result.smol = takeFlagValue(args, i++, "--smol");
		} else if (arg === "--slow") {
			result.slow = takeFlagValue(args, i++, "--slow");
		} else if (arg === "--plan") {
			result.plan = takeFlagValue(args, i++, "--plan");
		} else if (arg === "--mpreset") {
			result.mpreset = takeFlagValue(args, i++, "--mpreset");
		} else if (arg === "--default") {
			result.default = true;
		} else if (arg === "--api-key") {
			result.apiKey = takeFlagValue(args, i++, "--api-key");
		} else if (arg === "--credential") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				throw new CliParseError("--credential requires <selector>");
			}
			result.credential = args[++i];
		} else if (arg === "--prefer-credential") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				throw new CliParseError("--prefer-credential requires <selector>");
			}
			result.preferCredential = args[++i];
		} else if (arg === "--system-prompt") {
			result.systemPrompt = takePromptValue(args, i++, "--system-prompt", hasInlineValue);
		} else if (arg === "--append-system-prompt") {
			result.appendSystemPrompt = takePromptValue(args, i++, "--append-system-prompt", hasInlineValue);
		} else if (arg === "--clipboard-transport") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				throw new CliParseError("--clipboard-transport requires <auto|native|osc52|ssh>");
			}
			if (next !== "auto" && next !== "native" && next !== "osc52" && next !== "ssh") {
				throw new CliParseError(
					`invalid --clipboard-transport value: ${next} (expected auto, native, osc52, or ssh)`,
				);
			}
			result.clipboardTransport = args[++i] as "auto" | "native" | "osc52" | "ssh";
		} else if (arg === "--clipboard-ssh-host") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				throw new CliParseError("--clipboard-ssh-host requires <alias>");
			}
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) {
				throw new CliParseError(
					`invalid --clipboard-ssh-host value: ${JSON.stringify(next)} (must be a bare host alias — no whitespace, control characters, or leading dash)`,
				);
			}
			result.clipboardSshHost = args[++i];
		} else if (arg === "--mcp-config") {
			if (result.mcpConfig !== undefined) {
				throw new CliParseError("--mcp-config can only be specified once");
			}
			if (result.noMcp === true) {
				throw new CliParseError("--no-mcp and --mcp-config are mutually exclusive");
			}
			const next = args[i + 1];
			if (!next || next.startsWith("-") || !path.isAbsolute(next)) {
				throw new CliParseError("--mcp-config requires <absolute-path>");
			}
			result.mcpConfig = args[++i];
		} else if (arg === "--no-mcp") {
			result.noMcp = true;
			if (result.mcpConfig !== undefined) {
				throw new CliParseError("--no-mcp and --mcp-config are mutually exclusive");
			}
		} else if (arg === "--provider-session-id") {
			result.providerSessionId = takeFlagValue(args, i++, "--provider-session-id");
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session-dir") {
			result.sessionDir = takeFlagValue(args, i++, "--session-dir");
		} else if (arg === "--models") {
			result.models = takeFlagValue(args, i++, "--models")
				.split(",")
				.map(s => s.trim());
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--tmux") {
			result.tmux = true;
		} else if (arg === "--extension" || arg === "-e") {
			const extension = takeFlagValue(args, i++, "--extension");
			result.extensions = [...(result.extensions ?? []), extension];
			consumerFlags.set("extension", "--extension");
		} else if (arg === "--hook") {
			const hook = takeFlagValue(args, i++, "--hook");
			result.hooks = [...(result.hooks ?? []), hook];
			consumerFlags.set("hook", "--hook");
		} else if (arg === "--no-extensions") {
			result.noExtensions = true;
			consumerFlags.set("no-extensions", "--no-extensions");
		} else if (arg === "--no-skills") {
			result.noSkills = true;
			consumerFlags.set("no-skills", "--no-skills");
		} else if (arg === "--skills") {
			result.skills = takeFlagValue(args, i++, "--skills")
				.split(",")
				.map(s => s.trim())
				.filter(Boolean);
			consumerFlags.set("skills", "--skills");
		} else if (arg === "--tools") {
			const toolNames = takeFlagValue(args, i++, "--tools")
				.split(",")
				.map(s => s.trim().toLowerCase())
				.filter(Boolean);
			const validTools: string[] = [];
			for (const name of toolNames) {
				if (name in BUILTIN_TOOLS) {
					validTools.push(name);
				} else {
					logger.warn("Unknown tool passed to --tools", {
						tool: name,
						validTools: Object.keys(BUILTIN_TOOLS),
					});
				}
			}
			result.tools = validTools;
		} else if (arg === "--thinking") {
			if (hasThinkingFlag) {
				throw new CliParseError("--thinking can only be specified once");
			}
			hasThinkingFlag = true;
			// Match --credential / --mcp-config: a missing value or a following flag is
			// a usage error, not a silent no-op / accidental consumption of `-p`.
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				throw new CliParseError(`--thinking requires <level> (${ROOT_THINKING_LEVELS.join(", ")})`);
			}
			const rawThinking = args[++i];
			const thinking = parseThinkingLevel(rawThinking);
			if (thinking === undefined || thinking === ThinkingLevel.Inherit) {
				// Fail closed: a silent ignore left users believing `ultra` (or any typo)
				// was applied. Help / Flags.options advertise the root thinking levels.
				throw new CliParseError(
					`Invalid --thinking level "${rawThinking}". Expected one of: ${ROOT_THINKING_LEVELS.join(", ")}`,
				);
			}
			result.thinking = thinking;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--export") {
			result.export = takeFlagValue(args, i++, "--export");
		} else if (arg === "--no-rules") {
			result.noRules = true;
		} else if (arg === "--no-title") {
			result.noTitle = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		} else if (!isExternallyParsedRootFlagToken(arg)) {
			throw new CliParseError(`Root option is declared but not parsed: ${arg}`);
		}
	}

	if (result.masterScope !== undefined && result.master !== true) {
		throw new CliParseError("--scope requires --master");
	}
	if (result.master === true && result.masterScope === undefined) result.masterScope = "repo";
	if (result.default && !result.mpreset) {
		throw new CliParseError("--default requires --mpreset <name>");
	}
	if (result.credential && result.preferCredential) {
		throw new CliParseError("--credential and --prefer-credential cannot be used together");
	}
	if (result.apiKey && result.preferCredential) {
		throw new CliParseError("--api-key and --prefer-credential cannot be used together");
	}
	if (result.mcpConfig !== undefined && (result.listModels !== undefined || result.export !== undefined)) {
		throw new CliParseError(
			"--mcp-config is only supported in standalone interactive, tmux, print, text, or json modes.",
		);
	}

	CONSUMER_FLAGS_BY_ARGS.set(result, consumerFlags);
	if (authority === "local") assertLocalLaunchArgs(result);
	return result;
}

/** Reject flags whose only owners are non-local startup consumers. */
export function assertLocalLaunchArgs(parsed: Args): void {
	const unknown = parsed.unknownFlags.keys().next().value;
	if (unknown) throw new CliParseError(`Unknown option: ${unknown}`);
	for (const [name, token] of CONSUMER_FLAGS_BY_ARGS.get(parsed) ?? []) {
		if (!launchFlagIsOwnedBy(name, "local")) throw new CliParseError(`Unknown option: ${token}`);
	}
}
