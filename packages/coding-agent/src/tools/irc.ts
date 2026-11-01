/**
 * IRC tool — agent-to-agent messaging.
 *
 * Lets any live agent send a short prose message to any other live agent in
 * this process and (optionally) get a prose reply.
 *
 * Routing happens via the global AgentRegistry. Replies are produced by an
 * ephemeral side-channel call (`AgentSession.respondAsBackground`) that
 * mirrors `/btw`: the recipient's current model, system prompt, and message
 * history are used to compute a reply without persisting it through the
 * normal stream path. After the reply is generated, both the incoming
 * message and the auto-reply are injected into the recipient's persisted
 * history: an idle recipient gets them immediately, while a streaming recipient
 * receives them at its next step boundary (the live run's next tool boundary)
 * rather than at the end of its turn — an exchange admitted into a run that ends
 * before that boundary is still appended to the outgoing session's history.
 *
 * This avoids the deadlock that arises when the recipient is blocked on a
 * long-running tool call: the side-channel call does not depend on the
 * recipient's main agent loop being free.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import ircDescription from "../prompts/tools/irc.md" with { type: "text" };
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from ".";

const ircSchema = z.object({
	op: z.enum(["send", "list"]).describe("irc operation"),
	to: z.string().optional().describe('recipient agent id or "all"'),
	message: z.string().optional().describe("message body"),
	awaitReply: z.boolean().optional().describe("wait for prose reply"),
});

type IrcParams = z.infer<typeof ircSchema>;

interface IrcReply {
	from: string;
	text: string;
}

export interface IrcDetails {
	op: "send" | "list";
	from?: string;
	to?: string;
	delivered?: string[];
	replies?: IrcReply[];
	failed?: Array<{ id: string; error: string }>;
	notFound?: string[];
	peers?: Array<{ id: string; displayName: string; kind: string; status: string; parentId?: string }>;
	channels?: string[];
}

export class IrcTool implements AgentTool<typeof ircSchema, IrcDetails> {
	readonly name = "irc";
	readonly label = "IRC";
	readonly summary = "Send and receive messages between agents over IRC-like channels";
	readonly description: string;
	readonly parameters = ircSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(ircDescription);
	}

	static createIf(session: ToolSession): IrcTool | null {
		if (!session.settings.get("irc.enabled")) return null;
		if (!session.agentRegistry || !session.getAgentId) return null;
		return new IrcTool(session);
	}

	async execute(
		_toolCallId: string,
		params: IrcParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<IrcDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<IrcDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry) {
			return errorResult("IRC is unavailable in this session.", { op: params.op });
		}
		if (!senderId) {
			return errorResult("IRC is unavailable: caller has no agent id.", { op: params.op });
		}

		if (params.op === "list") {
			return this.#executeList(registry, senderId);
		}
		if (params.op === "send") {
			return this.#executeSend(registry, senderId, params, signal);
		}
		return errorResult("Unknown irc op.", { op: params.op as "send" | "list" });
	}

	#executeList(registry: AgentRegistry, senderId: string): AgentToolResult<IrcDetails> {
		const peers = registry.listVisibleTo(senderId);
		const lines: string[] = [];
		if (peers.length === 0) {
			lines.push("No other live agents.");
		} else {
			lines.push(`${peers.length} peer(s):`);
			for (const peer of peers) {
				lines.push(`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}]`);
			}
		}
		const channels = ["all", ...peers.map(p => p.id)];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "list",
				from: senderId,
				peers: peers.map(p => ({
					id: p.id,
					displayName: p.displayName,
					kind: p.kind,
					status: p.status,
					parentId: p.parentId,
				})),
				channels,
			},
		};
	}

	async #executeSend(
		registry: AgentRegistry,
		senderId: string,
		params: IrcParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<IrcDetails>> {
		const to = params.to?.trim();
		const message = params.message?.trim();
		if (!to) {
			return errorResult('`to` is required for op="send".', { op: "send", from: senderId });
		}
		if (!message) {
			return errorResult('`message` is required for op="send".', { op: "send", from: senderId });
		}

		// Resolve target peers.
		let targets: AgentRef[];
		const notFound: string[] = [];
		const isBroadcast = to === "all";
		if (isBroadcast) {
			targets = registry.listVisibleTo(senderId);
		} else {
			const ref = registry.get(to);
			if (!ref || ref.id === senderId) {
				notFound.push(to);
				targets = [];
			} else if (ref.status !== "running" && ref.status !== "idle") {
				notFound.push(to);
				targets = [];
			} else {
				targets = [ref];
			}
		}

		const awaitReply = params.awaitReply ?? !isBroadcast;

		const delivered: string[] = [];
		const replies: IrcReply[] = [];
		const failed: Array<{ id: string; error: string }> = [];

		// Dispatch to each target in parallel via the recipient's ephemeral
		// side-channel. Independent calls so a slow recipient cannot stall the
		// others. The recipient's main loop never has to be unblocked: the
		// side-channel runs alongside any in-flight tool call.
		const dispatches = targets.map(async target => {
			const targetSession = target.session;
			if (!targetSession) {
				notFound.push(target.id);
				return;
			}
			try {
				const result = await targetSession.respondAsBackground({
					from: senderId,
					message,
					awaitReply,
					signal,
				});
				delivered.push(target.id);
				if (awaitReply && result.replyText) {
					replies.push({ from: target.id, text: result.replyText });
				}
			} catch (err) {
				failed.push({ id: target.id, error: err instanceof Error ? err.message : String(err) });
			}
		});
		await Promise.all(dispatches);

		const lines: string[] = [];
		if (delivered.length === 0) {
			lines.push("No recipients received the message.");
		} else {
			lines.push(`Delivered to ${delivered.length} peer(s): ${delivered.join(", ")}`);
		}
		if (replies.length > 0) {
			lines.push("");
			lines.push("## Replies");
			for (const reply of replies) {
				lines.push(`### ${reply.from}`);
				lines.push(reply.text);
			}
		}
		if (failed.length > 0) {
			lines.push("");
			lines.push("## Failed");
			for (const f of failed) {
				lines.push(`- ${f.id}: ${f.error}`);
			}
		}
		if (notFound.length > 0) {
			lines.push("");
			lines.push(`Unknown / unavailable peers: ${notFound.join(", ")}`);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "send",
				from: senderId,
				to,
				delivered,
				...(replies.length > 0 ? { replies } : {}),
				...(failed.length > 0 ? { failed } : {}),
				...(notFound.length > 0 ? { notFound } : {}),
			},
		};
	}
}

function errorResult(text: string, details: IrcDetails): AgentToolResult<IrcDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}
