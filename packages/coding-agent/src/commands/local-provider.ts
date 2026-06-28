/**
 * Test configured local OpenAI-compatible providers.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runLocalProviderDiscoverCommand, runLocalProviderSmokeCommand } from "../cli/local-provider-smoke";

export const LOCAL_PROVIDER_ACTIONS = ["discover", "models", "smoke"] as const;
export const LOCAL_PROVIDER_DEFAULT_ACTION = "smoke";

export default class LocalProvider extends Command {
	static description = "Discover or test configured local OpenAI-compatible providers";

	static args = {
		action: Args.string({ description: "Action", required: false, options: LOCAL_PROVIDER_ACTIONS }),
	};

	static flags = {
		model: Flags.string({ description: "Model id to use for smoke (otherwise uses the first /models id)" }),
		"models-path": Flags.string({ description: "Override models config path" }),
		"timeout-ms": Flags.integer({ description: "Request timeout in milliseconds" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(LocalProvider);
		const action = args.action ?? LOCAL_PROVIDER_DEFAULT_ACTION;
		if (action === "discover" || action === "models") {
			await runLocalProviderDiscoverCommand({
				modelsPath: flags["models-path"],
				timeoutMs: flags["timeout-ms"],
				json: flags.json,
			});
			return;
		}
		if (action === "smoke") {
			await runLocalProviderSmokeCommand({
				model: flags.model,
				modelsPath: flags["models-path"],
				timeoutMs: flags["timeout-ms"],
				json: flags.json,
			});
			return;
		}
		process.stderr.write(`Unsupported local-provider action: ${action}\n`);
		process.exitCode = 1;
	}
}
