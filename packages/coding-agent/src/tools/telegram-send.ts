import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { z } from "zod/v4";
import { getTelegramFileSink } from "../notifications/attachment-registry";
import { getNotificationConfig, isGloballyConfigured } from "../notifications/config";
import type { ToolSession } from "./index";

const telegramSendSchema = z.object({
	path: z.string().describe("local file path (absolute or relative to cwd) to send to Telegram"),
	caption: z.string().optional().describe("optional caption"),
});

type TelegramSendParams = z.infer<typeof telegramSendSchema>;

interface TelegramSendDetails {
	path: string;
	caption?: string;
	ok: boolean;
	error?: string;
}

export class TelegramSendTool implements AgentTool<typeof telegramSendSchema, TelegramSendDetails> {
	readonly name = "telegram_send";
	readonly label = "TelegramSend";
	readonly summary = "Send a local file to Telegram";
	readonly loadMode = "discoverable";
	readonly description =
		"Send a local file to the connected Telegram chat as a document. Provide an absolute or cwd-relative path and an optional caption.";
	readonly parameters = telegramSendSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): TelegramSendTool | null {
		return isGloballyConfigured(getNotificationConfig(session.settings)) ? new TelegramSendTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: TelegramSendParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TelegramSendDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TelegramSendDetails>> {
		const sessionId = this.session.getSessionId?.();
		if (!sessionId) {
			return {
				content: [{ type: "text", text: "telegram_send: no active session id" }],
				details: { path: params.path, caption: params.caption, ok: false, error: "no active session id" },
				isError: true,
			};
		}

		const abs = path.isAbsolute(params.path) ? params.path : path.resolve(this.session.cwd, params.path);
		const sink = getTelegramFileSink(sessionId);
		if (!sink) {
			return {
				content: [
					{ type: "text", text: "telegram_send: Telegram notifications are not connected for this session" },
				],
				details: {
					path: abs,
					caption: params.caption,
					ok: false,
					error: "Telegram notifications are not connected",
				},
				isError: true,
			};
		}

		const result = await sink({ path: abs, caption: params.caption });
		if (result.ok) {
			return {
				content: [{ type: "text", text: `Sent ${path.basename(abs)} to Telegram.` }],
				details: { path: abs, caption: params.caption, ok: true },
			};
		}

		return {
			content: [{ type: "text", text: `telegram_send failed: ${result.error}` }],
			details: { path: abs, caption: params.caption, ok: false, error: result.error },
			isError: true,
		};
	}
}
