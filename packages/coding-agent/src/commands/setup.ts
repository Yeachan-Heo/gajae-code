/**
 * Install GJC defaults or optional feature dependencies.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { initTheme } from "../modes/theme/theme";

const COMPONENTS: SetupComponent[] = ["defaults", "hooks", "provider", "python", "stt"];

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
		preset: Flags.string({ description: "Provider preset: minimax, minimax-cn, or glm" }),
		compat: Flags.string({ description: "Provider compatibility: openai or anthropic" }),
		provider: Flags.string({ description: "Provider id to add to models.yml" }),
		"base-url": Flags.string({ description: "Provider API base URL" }),
		"api-key-env": Flags.string({ description: "Read provider API key from this environment variable" }),
		model: Flags.string({ description: "Model id to add (repeat or comma-separate)", multiple: true }),
		"models-path": Flags.string({ description: "Override models config path" }),
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
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
