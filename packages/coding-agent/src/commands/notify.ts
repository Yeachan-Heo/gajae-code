/**
 * Configure Telegram notifications.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { type NotifyAction, type NotifyCommandArgs, runNotifyCommand } from "../cli/notify-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: NotifyAction[] = ["setup", "status", "daemon-internal"];

export default class Notify extends Command {
	static description = "Configure Telegram notifications";

	static args = {
		action: Args.string({
			description: "Notify action",
			required: false,
			options: ACTIONS,
		}),
		extra: Args.string({
			description: "Additional internal args",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		smoke: Flags.boolean({ description: "Run hidden daemon smoke" }),
		token: Flags.string({ description: "Telegram bot token (non-interactive setup)" }),
		"chat-id": Flags.string({ description: "Telegram chat id to pair (non-interactive setup)" }),
		redact: Flags.boolean({ description: "Enable redaction of remote notification content" }),
		"owner-id": Flags.string({ description: "Internal: daemon owner id" }),
		"agent-dir": Flags.string({ description: "Internal: agent dir for the daemon" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Notify);
		const action = (args.action ?? "status") as NotifyAction;
		const extra = Array.isArray(args.extra) ? args.extra : args.extra ? [args.extra] : [];
		const flagRec = flags as Record<string, unknown>;
		const ownerId = flagRec["owner-id"] as string | undefined;
		const agentDir = flagRec["agent-dir"] as string | undefined;
		const rawArgs = [
			...(flags.smoke ? ["--smoke"] : []),
			...(ownerId ? ["--owner-id", ownerId] : []),
			...(agentDir ? ["--agent-dir", agentDir] : []),
			...extra,
		];

		const cmd: NotifyCommandArgs = {
			action,
			smoke: flags.smoke,
			rawArgs,
			token: flags.token as string | undefined,
			chatId: (flags as Record<string, unknown>)["chat-id"] as string | undefined,
			redact: Boolean(flags.redact),
		};

		await initTheme();
		await runNotifyCommand(cmd);
	}
}
