import { Flags } from "@gajae-code/utils/cli";

const ROOT_THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Public launch flags shared by root help, completion, and the launch command. */
export const ROOT_LAUNCH_FLAGS = {
	model: Flags.string({ description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2")' }),
	smol: Flags.string({ description: "Smol/fast model for lightweight tasks (or GJC_SMOL_MODEL env)" }),
	slow: Flags.string({ description: "Slow/reasoning model for thorough analysis (or GJC_SLOW_MODEL env)" }),
	plan: Flags.string({ description: "Plan model for architectural planning (or GJC_PLAN_MODEL env)" }),
	mpreset: Flags.string({ description: "Model profile preset to activate for this session" }),
	default: Flags.boolean({ description: "Persist --mpreset as the default model profile" }),
	provider: Flags.string({ description: "Provider to use (legacy; prefer --model)" }),
	"api-key": Flags.string({ description: "API key (defaults to env vars)" }),
	credential: Flags.string({
		description:
			"Stored credential selector: email:<addr>, id:<n>, account:<id>, project:<id>, or provider/email:<addr>",
	}),
	"system-prompt": Flags.string({ description: "System prompt (default: coding assistant prompt)" }),
	"append-system-prompt": Flags.string({ description: "Append text or file contents to the system prompt" }),
	"mcp-config": Flags.string({ description: "Tools-only MCP config file (absolute path)" }),
	"clipboard-transport": Flags.string({
		description: "Clipboard transport: auto (default), native, osc52, or ssh",
		options: ["auto", "native", "osc52", "ssh"],
	}),
	"clipboard-ssh-host": Flags.string({
		description: "SSH host alias for --clipboard-transport ssh (from ~/.ssh/config)",
	}),
	"allow-home": Flags.boolean({ description: "Allow starting in ~ without auto-switching to a temp dir" }),
	mode: Flags.string({
		description: "Output mode: text (default), json, or acp",
		options: ["text", "json", "acp"],
	}),
	print: Flags.boolean({ char: "p", description: "Non-interactive mode: process prompt and exit" }),
	continue: Flags.boolean({ char: "c", description: "Continue previous session" }),
	resume: Flags.string({
		char: "r",
		description: "Resume a session (by ID prefix, path, or picker if omitted)",
		optionalValue: true,
	}),
	fork: Flags.string({ description: "Fork a session (by ID prefix or path)" }),
	worktree: Flags.string({
		char: "w",
		description: "Launch in a managed worktree (optional branch name)",
		optionalValue: true,
	}),
	"session-dir": Flags.string({
		description: "Explicit session storage directory and lookup override (default uses managed v2 workspace scope)",
	}),
	"no-session": Flags.boolean({ description: "Don't save session (ephemeral)" }),
	models: Flags.string({ description: "Comma-separated model patterns for Alt+N cycling" }),
	"no-tools": Flags.boolean({ description: "Disable all built-in tools" }),
	"no-lsp": Flags.boolean({ description: "Disable LSP tools, formatting, and diagnostics" }),
	"no-pty": Flags.boolean({ description: "Disable PTY-based interactive bash execution" }),
	tmux: Flags.boolean({ description: "Launch interactive startup inside tmux" }),
	tools: Flags.string({ description: "Comma-separated list of tools to enable (default: all)" }),
	thinking: Flags.string({
		description: `Set thinking level: ${ROOT_THINKING_EFFORTS.join(", ")}`,
		options: ROOT_THINKING_EFFORTS,
	}),
	"no-rules": Flags.boolean({ description: "Disable rules discovery and loading" }),
	export: Flags.string({ description: "Export session file to HTML and exit" }),
	"list-models": Flags.string({
		description: "List available models (with optional fuzzy search)",
		optionalValue: true,
	}),
	"no-title": Flags.boolean({ description: "Disable title auto-generation" }),
};
