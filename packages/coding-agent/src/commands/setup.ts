/**
 * Install GJC defaults or optional feature dependencies.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { initTheme } from "../modes/theme/theme";

const COMPONENTS: SetupComponent[] = [
	"claude",
	"codex",
	"credentials",
	"defaults",
	"hermes",
	"hooks",
	"provider",
	"python",
	"stt",
];

export default class Setup extends Command {
	static description = "Install GJC defaults or optional feature dependencies";

	static args = {
		component: Args.string({
			description: "Component to install (defaults when omitted)",
			required: false,
			options: COMPONENTS,
		}),
	};

	static flags = {
		check: Flags.boolean({ char: "c", description: "Check if dependencies are installed" }),
		force: Flags.boolean({ char: "f", description: "Overwrite existing default workflow skill files" }),
		json: Flags.boolean({ description: "Output status as JSON" }),
		smoke: Flags.boolean({ description: "Run Hermes MCP setup smoke checks" }),
		install: Flags.boolean({ description: "Install generated Hermes setup files" }),
		root: Flags.string({ description: "Allowed Hermes MCP workdir/artifact root (repeatable)", multiple: true }),
		repo: Flags.string({ description: "Hermes MCP repo namespace" }),
		profile: Flags.string({ description: "Hermes MCP profile namespace" }),
		"session-command": Flags.string({ description: "Explicit GJC session command for Hermes to launch" }),
		"no-worktree": Flags.boolean({ description: "Disable default GJC --worktree isolation for Hermes sessions" }),
		"worktree-name": Flags.string({ description: "Named GJC --worktree branch for Hermes sessions" }),
		"state-root": Flags.string({ description: "Hermes MCP coordination state root" }),
		mutation: Flags.string({
			description: "Hermes MCP mutation classes: sessions,questions,reports,all",
			multiple: true,
		}),
		"artifact-byte-cap": Flags.string({ description: "Hermes MCP artifact read byte cap" }),
		"server-key": Flags.string({ description: "Hermes MCP server key in coordinator config" }),
		"gjc-command": Flags.string({ description: "Command used to start `gjc mcp-serve coordinator`" }),
		target: Flags.string({ description: "Hermes config file target for config-only install" }),
		"profile-dir": Flags.string({ description: "Hermes profile directory for full setup install" }),
		preset: Flags.string({ description: "Provider preset: minimax, minimax-cn, or glm" }),
		compat: Flags.string({ description: "Provider compatibility: openai or anthropic" }),
		provider: Flags.string({ description: "Provider id to add to models.yml" }),
		"base-url": Flags.string({ description: "Provider API base URL" }),
		"api-key-env": Flags.string({ description: "Read provider API key from this environment variable" }),
		model: Flags.string({ description: "Model id to add (repeat or comma-separate)", multiple: true }),
		"models-path": Flags.string({ description: "Override models config path" }),
		yes: Flags.boolean({ char: "y", description: "Import discovered credentials without an interactive prompt" }),
		"dry-run": Flags.boolean({ description: "Preview discovered credentials without importing" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		const cmd: SetupCommandArgs = {
			component: (args.component ?? "defaults") as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
				force: flags.force,
				preset: flags.preset,
				compat: flags.compat,
				provider: flags.provider,
				baseUrl: flags["base-url"],
				apiKeyEnv: flags["api-key-env"],
				model: flags.model,
				modelsPath: flags["models-path"],
				smoke: flags.smoke,
				install: flags.install,
				root: flags.root,
				repo: flags.repo,
				profile: flags.profile,
				sessionCommand: flags["session-command"],
				noWorktree: flags["no-worktree"],
				worktreeName: flags["worktree-name"],
				stateRoot: flags["state-root"],
				mutation: flags.mutation,
				artifactByteCap: flags["artifact-byte-cap"],
				serverKey: flags["server-key"],
				gjcCommand: flags["gjc-command"],
				target: flags.target,
				profileDir: flags["profile-dir"],
				yes: flags.yes,
				dryRun: flags["dry-run"],
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
