import type {
	NotificationAdapterPayload,
	NotificationEvent,
	NotificationPresentationAdapter,
	NotificationReplyRoute,
} from "./engine";
import { truncate } from "./helpers";

type AdapterKind = "discord" | "slack";

interface ChatAdapterOptions {
	kind: AdapterKind;
	channelId?: string;
}

interface InboundShape {
	sessionId?: unknown;
	actionId?: unknown;
	answer?: unknown;
	text?: unknown;
	value?: unknown;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function publicLine(label: string, value: unknown): string | undefined {
	const v = text(value);
	return v ? `${label}: ${truncate(v, 280)}` : undefined;
}

function actionText(event: Extract<NotificationEvent, { type: "action_needed" }>, format: "discord" | "slack"): string {
	if (event.kind === "idle") {
		const summary = text(event.summary);
		return summary ? `Agent idle\n${truncate(summary, 1200)}` : "Agent idle";
	}
	const question = truncate(text(event.question) ?? "Question", 1200);
	const options = Array.isArray(event.options) ? event.options.map(option => String(option)) : [];
	const lines = [`Question: ${question}`];
	if (options.length > 0) {
		lines.push(
			...options.map((option, index) => {
				const label = truncate(option, 180);
				return format === "slack" ? `${index + 1}. ${label}` : `**${index + 1}.** ${label}`;
			}),
		);
	} else {
		lines.push("Reply with text.");
	}
	return lines.join("\n");
}

function frameText(event: Extract<NotificationEvent, { type: "frame" }>): string | undefined {
	const frame = event.frame;
	const kind = text(frame.type);
	if (!kind) return undefined;
	const lines = [`GJC ${kind.replace(/_/g, " ")}`];
	for (const line of [
		publicLine("title", frame.title),
		publicLine("repo", frame.repo),
		publicLine("branch", frame.branch),
		publicLine("task", frame.task),
		publicLine("goal", frame.goal),
		publicLine("model", frame.model),
	]) {
		if (line) lines.push(line);
	}
	const body = text(frame.text) ?? text(frame.lastMessage) ?? text(frame.caption);
	if (body) lines.push(truncate(body, 1800));
	return lines.join("\n");
}

function routeFromInbound(input: unknown): NotificationReplyRoute | undefined {
	const raw = input as InboundShape;
	if (!raw || typeof raw !== "object") return undefined;
	const sessionId = text(raw.sessionId);
	const actionId = text(raw.actionId);
	if (!sessionId || !actionId) return undefined;
	const answer = raw.answer ?? raw.value ?? raw.text;
	if (typeof answer !== "string" && typeof answer !== "number" && typeof answer !== "object") return undefined;
	return { sessionId, actionId, answer: answer as NotificationReplyRoute["answer"] };
}

class DiscordNotificationAdapter implements NotificationPresentationAdapter {
	readonly kind = "discord" as const;
	constructor(private readonly opts: ChatAdapterOptions) {}

	render(event: NotificationEvent): NotificationAdapterPayload[] {
		if (event.type === "action_resolved") return [];
		const content = event.type === "action_needed" ? actionText(event, "discord") : frameText(event);
		if (!content) return [];
		const payload: Record<string, unknown> = {
			content,
			allowed_mentions: { parse: [] },
		};
		if (this.opts.channelId) payload.channel_id = this.opts.channelId;
		return [
			{
				adapter: this.kind,
				channelKey: this.opts.channelId,
				body: payload,
				route: event.type === "action_needed" ? { sessionId: event.sessionId, actionId: event.id } : undefined,
			},
		];
	}

	mapInbound(input: unknown): NotificationReplyRoute | undefined {
		return routeFromInbound(input);
	}
}

class SlackNotificationAdapter implements NotificationPresentationAdapter {
	readonly kind = "slack" as const;
	constructor(private readonly opts: ChatAdapterOptions) {}

	render(event: NotificationEvent): NotificationAdapterPayload[] {
		if (event.type === "action_resolved") return [];
		const textValue = event.type === "action_needed" ? actionText(event, "slack") : frameText(event);
		if (!textValue) return [];
		const payload: Record<string, unknown> = {
			text: textValue,
			mrkdwn: true,
		};
		if (this.opts.channelId) payload.channel = this.opts.channelId;
		return [
			{
				adapter: this.kind,
				channelKey: this.opts.channelId,
				body: payload,
				route: event.type === "action_needed" ? { sessionId: event.sessionId, actionId: event.id } : undefined,
			},
		];
	}

	mapInbound(input: unknown): NotificationReplyRoute | undefined {
		return routeFromInbound(input);
	}
}

export function createDiscordAdapter(opts: Omit<ChatAdapterOptions, "kind"> = {}): NotificationPresentationAdapter {
	return new DiscordNotificationAdapter({ ...opts, kind: "discord" });
}

export function createSlackAdapter(opts: Omit<ChatAdapterOptions, "kind"> = {}): NotificationPresentationAdapter {
	return new SlackNotificationAdapter({ ...opts, kind: "slack" });
}
