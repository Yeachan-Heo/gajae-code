/**
 * `gjc auth-gateway` — run a forward proxy that injects auth from the broker.
 */
import { Args, Command, Flags, renderCommandHelp } from "@gajae-code/utils/cli";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { initTheme } from "../modes/theme/theme";

export default class AuthGateway extends Command {
	static description = "Run an auth-gateway forward proxy backed by the configured broker";

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status/check)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		provider: Flags.string({
			description: "Required provider scope for `serve`; also filters `status` and `check`",
		}),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token (token)" }),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Loopback non-browser clients without an Origin header are allowed.",
		}),
	};

	static examples = [
		"# Boot a provider-scoped gateway against the configured broker\n  gjc auth-gateway serve --provider=openai-codex",
		"# Boot on a non-default port\n  gjc auth-gateway serve --provider=openai-codex --bind=127.0.0.1:4000",
		"# Print the gateway bearer token (creates one on first run)\n  gjc auth-gateway token",
		"# Rotate the gateway bearer token\n  gjc auth-gateway token --regenerate",
		"# Run the scoped gateway on loopback for non-browser local clients without a bearer\n  gjc auth-gateway serve --provider=openai-codex --no-auth",
		"# Show scoped local gateway + broker config status\n  gjc auth-gateway status --provider=openai-codex",
		"# Probe credentials for one gateway scope\n  gjc auth-gateway check --provider=openai-codex",
		"# Same, machine-readable for scripts\n  gjc auth-gateway check --provider=openai-codex --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthGateway);
		if (!args.action) {
			renderCommandHelp("gjc", "auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				provider: flags.provider,
				regenerate: flags.regenerate,
				noAuth: flags["no-auth"],
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
