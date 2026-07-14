/**
 * CLI argument parsing and help display
 */
import { type Effort, THINKING_EFFORTS } from "@gajae-code/ai";
import { APP_NAME, CONFIG_DIR_NAME, logger } from "@gajae-code/utils";
import { CliParseError } from "@gajae-code/utils/cli";
import chalk from "chalk";
import { parseEffort } from "../thinking";
import { BUILTIN_TOOLS } from "../tools";

export type Mode = "text" | "json" | "acp";

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
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: Effort;
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
	messages: string[];
	fileArgs: string[];
	/** Retained for test/runtime compatibility; extension-defined flags are no longer parsed. */
	unknownFlags: Map<string, boolean | string>;
	/** Exact interactive startup login intent, recognized before model-profile activation. */
	authBootstrap?: true;
}

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

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
	};

	for (let i = 0; i < args.length; i++) {
		let arg = args[i];

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

		// Support --flag=value syntax (e.g. --tools=ask,read)
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			// Insert the value so the existing "args[++i]" logic picks it up
			args.splice(i + 1, 0, value);
		}

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
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
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--smol" && i + 1 < args.length) {
			result.smol = args[++i];
		} else if (arg === "--slow" && i + 1 < args.length) {
			result.slow = args[++i];
		} else if (arg === "--plan" && i + 1 < args.length) {
			result.plan = args[++i];
		} else if (arg === "--mpreset" && i + 1 < args.length) {
			result.mpreset = args[++i];
		} else if (arg === "--default") {
			result.default = true;
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--credential") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				throw new CliParseError("--credential requires <selector>");
			}
			result.credential = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = args[++i];
		} else if (arg === "--provider-session-id" && i + 1 < args.length) {
			result.providerSessionId = args[++i];
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map(s => s.trim());
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--tmux") {
			result.tmux = true;
		} else if (arg === "--tools" && i + 1 < args.length) {
			const toolNames = args[++i]
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
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const rawThinking = args[++i];
			const thinking = parseEffort(rawThinking);
			if (thinking !== undefined) {
				result.thinking = thinking;
			} else {
				logger.warn("Invalid thinking level passed to --thinking", {
					level: rawThinking,
					validThinkingLevels: THINKING_EFFORTS,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
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
		}
	}

	if (result.default && !result.mpreset) {
		throw new Error("--default requires --mpreset <name>");
	}

	return result;
}

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Core Providers")}
  ANTHROPIC_API_KEY          - Anthropic Claude models
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth (takes precedence over API key)
  CLAUDE_CODE_USE_FOUNDRY    - Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry base URL (e.g., https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Anthropic token used as Authorization: Bearer <token> in Foundry mode
  ANTHROPIC_CUSTOM_HEADERS   - Extra Foundry headers (e.g., "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - Client certificate (PEM path or inline PEM) for mTLS
  CLAUDE_CODE_CLIENT_KEY     - Client private key (PEM path or inline PEM) for mTLS
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation
  OPENAI_API_KEY             - OpenAI GPT models
  GEMINI_API_KEY             - Google Gemini models
  GITHUB_TOKEN               - GitHub Copilot (or GH_TOKEN, COPILOT_GITHUB_TOKEN)

  ${chalk.dim("# Additional LLM Providers")}
  AZURE_OPENAI_API_KEY       - Azure OpenAI models
  GROQ_API_KEY               - Groq models
  CEREBRAS_API_KEY           - Cerebras models
  XAI_API_KEY                - xAI Grok models
  OPENROUTER_API_KEY         - OpenRouter aggregated models
  KILO_API_KEY               - Kilo Gateway models
  MISTRAL_API_KEY            - Mistral models
  ZAI_API_KEY                - z.ai models (ZhipuAI/GLM)
  MINIMAX_API_KEY            - MiniMax models
  OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go models
  CURSOR_ACCESS_TOKEN        - Cursor AI models
  AI_GATEWAY_API_KEY         - Vercel AI Gateway

  ${chalk.dim("# Cloud Providers")}
  AWS_PROFILE                - AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Service account for Vertex AI

  ${chalk.dim("# Search & Tools")}
  EXA_API_KEY                - Exa web search
  BRAVE_API_KEY              - Brave web search
  PERPLEXITY_API_KEY         - Perplexity web search (API)
  PERPLEXITY_COOKIES         - Perplexity web search (session cookie)
  TAVILY_API_KEY             - Tavily web search
  ANTHROPIC_SEARCH_API_KEY   - Anthropic search provider

  ${chalk.dim("# Configuration")}
  GJC_CODING_AGENT_DIR       - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  GJC_PACKAGE_DIR            - Override package directory (for Nix/Guix store paths)
  GJC_SMOL_MODEL              - Override smol/fast model (see --smol)
  GJC_SLOW_MODEL              - Override slow/reasoning model (see --slow)
  GJC_PLAN_MODEL              - Override planning model (see --plan)
  GJC_NO_PTY                  - Disable PTY-based interactive bash execution
  --tmux                       - Launch interactive startup inside a fresh tmux session
  gjc session                  - List, inspect, create, remove, or attach tagged GJC-managed tmux sessions
  GJC_LAUNCH_POLICY           - Launch policy for --tmux startup: tmux or direct
  GJC_TMUX_SESSION            - Explicit tmux session name override for --tmux startup
  GJC_TMUX_PROFILE            - Apply GJC tmux scroll/mouse/clipboard profile to --tmux sessions (set 0/off to skip)
  GJC_MOUSE                   - Mouse-wheel scroll in --tmux sessions (set 0/off to let the host terminal scroll)

  For complete environment variable reference, see:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("Available Tools (default-enabled unless noted):")}
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  find          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  browser       - Browser automation (Puppeteer)
  task          - Launch sub-agents for parallel tasks
  todo_write    - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

${chalk.bold("Useful Commands:")}
  ${APP_NAME} --list-models        - List configured provider models
  ${APP_NAME} --help               - Show this help`;
}

export function printHelp(): void {
	process.stdout.write(
		`${chalk.bold(APP_NAME)} - red-claw AI coding assistant\n\n` +
			`Run ${APP_NAME} --help for full command and option details.\n` +
			`Run ${APP_NAME} <command> --help for command-specific help.\n\n` +
			`${getExtraHelpText()}\n`,
	);
}
