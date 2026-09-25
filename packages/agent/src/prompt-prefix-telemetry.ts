/**
 * Per-request prompt-prefix telemetry (issue #5946).
 *
 * Provider prompt caches are prefix caches. When a mid-session request sends
 * almost no `cacheRead`, the miss was either caused by the client (it changed
 * bytes the previous request had already sent) or by the provider (routing,
 * eviction, TTL). Comparing each request against the previous request from the
 * same agent separates the two without retaining any prompt text.
 */

import type { Context, Message, Model, PromptPrefixChange, PromptPrefixTelemetry } from "@gajae-code/ai";

/**
 * Per-call request options that provider adapters use when serializing the
 * context (e.g. Anthropic drops replayed thinking under a forced tool choice).
 * They are part of the provider-visible request, so a change is client-caused.
 */
export interface PromptPrefixRequestOptions {
	toolChoice?: unknown;
	reasoning?: unknown;
	serviceTier?: unknown;
}

interface PromptPrefixObservation {
	modelKey: string;
	optionsHash: bigint;
	systemHash: bigint;
	toolsHash: bigint;
	messageHashes: bigint[];
	messageRoles: Message["role"][];
}

/** Tool schemas can carry bigint bounds (e.g. 64-bit integer limits), which plain JSON.stringify rejects. */
function bigintSafe(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? `${value}n` : value;
}

function hashJson(value: unknown): bigint {
	return Bun.hash.xxHash64(JSON.stringify(value, bigintSafe) ?? "null");
}

/**
 * Tracks the last request an agent sent and classifies how the next request's
 * prefix relates to it. One tracker per agent: subagents and side-channel
 * sessions have their own provider cache lineage.
 */
export class PromptPrefixTracker {
	#previous: PromptPrefixObservation | undefined;

	/**
	 * Record the exact provider-visible request and classify it against the previous one.
	 * Telemetry must never fail a turn: an unhashable request yields `undefined` and
	 * resets the lineage so the next request is reported as `initial`.
	 */
	observe(
		model: Pick<Model, "provider" | "id">,
		context: Context,
		options: PromptPrefixRequestOptions = {},
	): PromptPrefixTelemetry | undefined {
		try {
			return this.#observe(model, context, options);
		} catch {
			this.#previous = undefined;
			return undefined;
		}
	}

	#observe(
		model: Pick<Model, "provider" | "id">,
		context: Context,
		options: PromptPrefixRequestOptions = {},
	): PromptPrefixTelemetry {
		const current: PromptPrefixObservation = {
			modelKey: `${model.provider}/${model.id}`,
			optionsHash: hashJson([options.toolChoice ?? null, options.reasoning ?? null, options.serviceTier ?? null]),
			systemHash: hashJson(context.systemPrompt ?? []),
			toolsHash: hashJson(context.tools ?? []),
			messageHashes: context.messages.map(hashJson),
			messageRoles: context.messages.map(message => message.role),
		};
		const previous = this.#previous;
		this.#previous = current;

		let reusedMessages = 0;
		if (previous && previous.modelKey === current.modelKey) {
			const max = Math.min(previous.messageHashes.length, current.messageHashes.length);
			while (
				reusedMessages < max &&
				previous.messageHashes[reusedMessages] === current.messageHashes[reusedMessages]
			)
				reusedMessages++;
		}

		let change: PromptPrefixChange;
		if (!previous) change = "initial";
		else if (previous.modelKey !== current.modelKey) change = "model";
		else if (previous.toolsHash !== current.toolsHash) change = "tools";
		else if (previous.systemHash !== current.systemHash) change = "system";
		else if (reusedMessages < previous.messageHashes.length) change = "messages";
		else if (previous.optionsHash !== current.optionsHash) change = "options";
		else change = "append";

		const hash = Bun.hash
			.xxHash64(
				`${current.modelKey}|${current.optionsHash}|${current.toolsHash}|${current.systemHash}|${current.messageHashes.join(",")}`,
			)
			.toString(16)
			.padStart(16, "0");
		return {
			hash,
			messages: current.messageHashes.length,
			reusedMessages,
			previousMessages: previous?.messageHashes.length ?? 0,
			change,
			...(change === "messages" && previous ? { divergedRole: previous.messageRoles[reusedMessages] } : {}),
		};
	}
}
