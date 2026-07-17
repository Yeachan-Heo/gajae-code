/**
 * Configure Telegram, Discord, or Slack notifications.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { type NotifyAction, type NotifyCommandArgs, runNotifyCliCommand } from "../cli/notify-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: NotifyAction[] = ["setup", "status", "health", "test", "recovery", "daemon-internal"];

export default class Notify extends Command {
	static description = "Configure Telegram, Discord, or Slack notifications";

	static args = {
		action: Args.string({
			description: "Notify action (setup|status|health|test|recovery|daemon-internal)",
			required: false,
		}),
		extra: Args.string({
			description: "Provider or additional internal args",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		smoke: Flags.boolean({ description: "Run hidden daemon smoke" }),
		token: Flags.string({ description: "Telegram bot token (non-interactive setup)" }),
		"chat-id": Flags.string({ description: "Telegram chat id to pair (non-interactive setup)" }),
		"discord-bot-token": Flags.string({ description: "Discord bot token (non-interactive Discord setup)" }),
		"discord-application-id": Flags.string({ description: "Discord application id (non-interactive Discord setup)" }),
		"discord-guild-id": Flags.string({ description: "Discord guild id (non-interactive Discord setup)" }),
		"discord-parent-channel-id": Flags.string({
			description: "Discord parent channel id (non-interactive Discord setup)",
		}),
		"slack-bot-token": Flags.string({ description: "Slack bot token (non-interactive Slack setup)" }),
		"slack-app-token": Flags.string({ description: "Slack app token (non-interactive Slack setup)" }),
		"slack-workspace-id": Flags.string({ description: "Slack workspace id (non-interactive Slack setup)" }),
		"slack-channel-id": Flags.string({ description: "Slack channel id (non-interactive Slack setup)" }),
		"slack-authorized-user-id": Flags.string({
			description: "Slack user id authorized for inbound replies and commands",
		}),
		redact: Flags.boolean({ description: "Enable redaction of remote notification content" }),
		probe: Flags.boolean({ description: "notify health: probe Telegram reachability (getMe)" }),
		message: Flags.string({ description: "notify test: custom message body" }),
		"owner-id": Flags.string({ description: "Internal: daemon owner id" }),
		"agent-dir": Flags.string({ description: "Internal: agent dir for the daemon" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Notify);
		const action = args.action ?? "status";
		if (!ACTIONS.includes(action as NotifyAction)) {
			console.error(`Unknown notify action: ${action}`);
			console.error(`Valid actions: ${ACTIONS.join(", ")}`);
			process.exit(1);
		}
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
		const provider = extra[0];
		if (
			action === "setup" &&
			provider !== undefined &&
			provider !== "telegram" &&
			provider !== "discord" &&
			provider !== "slack"
		) {
			throw new Error(`Unknown notification provider: ${provider}`);
		}

		const cmd: NotifyCommandArgs = {
			action: action as NotifyAction,
			smoke: flags.smoke,
			rawArgs,
			provider: provider === "telegram" || provider === "discord" || provider === "slack" ? provider : undefined,
			token: flags.token as string | undefined,
			chatId: (flags as Record<string, unknown>)["chat-id"] as string | undefined,
			discordBotToken: flagRec["discord-bot-token"] as string | undefined,
			discordApplicationId: flagRec["discord-application-id"] as string | undefined,
			discordGuildId: flagRec["discord-guild-id"] as string | undefined,
			discordParentChannelId: flagRec["discord-parent-channel-id"] as string | undefined,
			slackBotToken: flagRec["slack-bot-token"] as string | undefined,
			slackAppToken: flagRec["slack-app-token"] as string | undefined,
			slackWorkspaceId: flagRec["slack-workspace-id"] as string | undefined,
			slackChannelId: flagRec["slack-channel-id"] as string | undefined,
			slackAuthorizedUserId: flagRec["slack-authorized-user-id"] as string | undefined,
			redact: Boolean(flags.redact),
			probe: Boolean(flags.probe),
			message: flags.message as string | undefined,
		};

		if (action !== "daemon-internal") await initTheme();
		await runNotifyCliCommand(cmd);
	}
}
