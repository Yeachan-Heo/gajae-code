import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { z } from "zod/v4";
import { getTelegramFileSink } from "../sdk/bus/attachment-registry";
import { getNotificationConfig, isGloballyConfigured } from "../sdk/bus/config";
import type { ToolSession } from "./index";

const TELEGRAM_SEND_MAX_FILE_BYTES = 50 * 1024 * 1024;
const TELEGRAM_SEND_MAX_FILE_MIB = TELEGRAM_SEND_MAX_FILE_BYTES / (1024 * 1024);

const telegramSendSchema = z.object({
	path: z
		.string()
		.describe("file path (absolute or relative to cwd) to send to Telegram; must resolve inside the workspace"),
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
	readonly summary = "Send a workspace file to Telegram";
	readonly loadMode = "discoverable";
	readonly description =
		"Send a file from the current workspace to the connected Telegram chat as a document. The path must resolve " +
		"(after following symlinks) to a regular file inside the project root; paths outside the workspace are rejected.";
	readonly parameters = telegramSendSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): TelegramSendTool | null {
		return isGloballyConfigured(getNotificationConfig(session.settings)) ? new TelegramSendTool(session) : null;
	}

	/**
	 * Resolve `requested` against the workspace root and confine it via realpath:
	 * blocks absolute paths outside the project, `..` traversal, and symlinks that
	 * escape the root. Returns the resolved real path of a regular file, or an
	 * error message. This is the egress safety boundary — the model can only send
	 * files that genuinely live inside the session workspace.
	 */
	private async resolveContainedFile(
		requested: string,
	): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
		let root: string;
		try {
			root = await fs.promises.realpath(this.session.cwd);
		} catch {
			return { ok: false, error: "workspace root is unavailable" };
		}
		const absolute = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
		let real: string;
		try {
			real = await fs.promises.realpath(absolute);
		} catch {
			return { ok: false, error: `file not found: ${requested}` };
		}
		const rel = path.relative(root, real);
		if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
			return { ok: false, error: "path escapes the workspace root; only files inside the project can be sent" };
		}
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(real);
		} catch {
			return { ok: false, error: `file not found: ${requested}` };
		}
		if (!stat.isFile()) {
			return { ok: false, error: "not a regular file" };
		}
		if (stat.size > TELEGRAM_SEND_MAX_FILE_BYTES) {
			return { ok: false, error: `file exceeds Telegram document limit (${TELEGRAM_SEND_MAX_FILE_MIB} MiB)` };
		}
		return { ok: true, path: real };
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

		const contained = await this.resolveContainedFile(params.path);
		if (!contained.ok) {
			return {
				content: [{ type: "text", text: `telegram_send: ${contained.error}` }],
				details: { path: params.path, caption: params.caption, ok: false, error: contained.error },
				isError: true,
			};
		}
		const abs = contained.path;

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
