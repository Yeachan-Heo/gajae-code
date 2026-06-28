/**
 * Test configured local OpenAI-compatible providers.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runLocalProviderSmokeCommand } from "../cli/local-provider-smoke";

const ACTIONS = ["smoke"] as const;

export default class LocalProvider extends Command {
	static description = "Test configured local OpenAI-compatible providers";

	static args = {
		action: Args.string({ description: "Action", required: false, options: ACTIONS }),
	};

	static flags = {
		model: Flags.string({ description: "Model id to use (otherwise uses the first /models id)" }),
		"models-path": Flags.string({ description: "Override models config path" }),
		"timeout-ms": Flags.integer({ description: "Request timeout in milliseconds" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(LocalProvider);
		const action = args.action ?? "smoke";
		if (action !== "smoke") {
			process.stderr.write(`Unsupported local-provider action: ${action}\n`);
			process.exitCode = 1;
			return;
		}
		await runLocalProviderSmokeCommand({
			model: flags.model,
			modelsPath: flags["models-path"],
			timeoutMs: flags["timeout-ms"],
			json: flags.json,
		});
	}
}
