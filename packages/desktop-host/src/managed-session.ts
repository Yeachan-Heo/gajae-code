import * as crypto from "node:crypto";
import * as path from "node:path";
import { type Q10Model, lifecycle as sdkLifecycle, router as sdkRouter } from "@gajae-code/coding-agent/sdk";
import { getThinkingLevelMetadata, parseThinkingLevel } from "@gajae-code/coding-agent/thinking";
import {
	countVisibleMessages,
	fitMessages,
	HISTORY_LIMIT,
	projectHistoryPage,
	projectMessages,
} from "./message-projection";
import type { DesktopDeliveryReceipt, DesktopHistory, DesktopMessage, DesktopModel, DesktopSession } from "./protocol";

const actor = { id: "desktop", namespace: "desktop-managed" };
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
class ManagedRefusalError extends Error {}

const unavailableInteraction =
	"This SDK owner cannot present desktop questions or approval screens. Answer in its original control surface.";

export interface ManagedSessionOptions {
	agentDir: string;
	cwd: string;
	id: string;
	projectId: string;
	title: string;
	starred: boolean;
	/** Desktop-issued epoch; the SDK's numeric generation may be reused by a successor. */
	nextControlGeneration: () => number;
	onChange: () => void;
	delivery: (
		id: string,
		changes: Partial<Pick<DesktopDeliveryReceipt, "disposition" | "sdkSubmissionId" | "error">>,
	) => Promise<void>;
	redact: (text: string) => string;
	/** Existing SDK seams, also used by deterministic owned-endpoint fixtures. */
	lifecycle?: sdkLifecycle.SessionLifecycleService;
	createRouter?: (
		onFrame: (attachment: sdkRouter.SessionAttachment, frame: sdkRouter.SessionRouterFrame) => void,
	) => sdkRouter.SessionRouter;
}

/** A demanding SDK client, never a transcript writer or an owner of the terminal process. */
export class ManagedSession {
	readonly #options: ManagedSessionOptions;
	readonly #router: sdkRouter.SessionRouter;
	#attachment?: sdkRouter.SessionAttachment;
	#controlEpoch: number | null = null;
	#messages: unknown[] = [];
	#models: Q10Model[] = [];
	#title: string;
	#idle = true;
	#waiting = false;
	#error?: string;
	#closed = false;
	#refresh?: Promise<void>;
	#dirty = false;
	#timer?: Timer;
	#deliveries = new Map<string, { kind: "prompt" | "steer"; commandId?: string; turnId?: string }>();

	constructor(options: ManagedSessionOptions) {
		this.#options = options;
		this.#title = options.title;
		const onFrame = (_attachment: sdkRouter.SessionAttachment, frame: sdkRouter.SessionRouterFrame) => {
			if (!["query_response", "control_response", "hello", "pong", "protocol_error"].includes(frame.name ?? ""))
				this.#scheduleRefresh();
		};
		this.#router =
			options.createRouter?.(onFrame) ??
			new sdkRouter.SessionRouter({
				agentDir: options.agentDir,
				sessionIds: [options.id],
				deps: {
					onFrame,
					onAttachmentReady: () => this.#scheduleRefresh(),
					onSessionRemoved: () => {
						this.#error = "SDK owner disconnected. Select the conversation again to reconnect.";
						options.onChange();
					},
				},
			});
	}

	get isAttached(): boolean {
		return !this.#closed && this.#attachment?.isCurrent() === true;
	}

	get controlGeneration(): number | null {
		return this.isAttached ? this.#controlEpoch : null;
	}

	async open(): Promise<void> {
		const { id, cwd, agentDir } = this.#options;
		const lifecycle = this.#options.lifecycle ?? new sdkLifecycle.AgentDirSessionLifecycleService(agentDir);
		const listed = await lifecycle.list({
			actor,
			capability: "session.list",
			target: { cwd, resolveSessionId: id },
		});
		if (!listed.ok) throw new Error(`SDK session discovery failed: ${listed.error.code}`);
		if ("rows" in listed.result)
			throw new Error("SDK session discovery returned a search result instead of an exact reference");
		const saved = listed.result.savedSession;
		if (!saved || saved.id !== id)
			throw new Error(
				`SDK session is unavailable: ${listed.result.savedSessionOmission?.reason ?? "candidate_not_found"}`,
			);
		const resumed = await lifecycle.resume({
			actor,
			capability: "session.resume",
			requestKey: crypto.randomUUID(),
			target: {
				sessionId: id,
				cwd,
				stateRoot: path.join(cwd, ".gjc", "state"),
				sessionPath: saved.path,
				sessionIdentity: saved.identity,
			},
		});
		if (!resumed.ok) throw new Error(`SDK resume ${resumed.certainty}: ${resumed.error.code}`);
		if (this.#closed) throw new Error("Desktop session was detached while connecting");
		await this.#router.start();
		const binding = await this.#router.bindingAuthority(id);
		if (
			!binding ||
			binding.endpointGeneration !== resumed.result.endpointGeneration ||
			binding.endpointIncarnation !== resumed.result.endpointIncarnation
		)
			throw new Error("SDK owner changed during resume. Select the conversation again.");
		this.#attachment = this.#router.attachment(id) ?? undefined;
		if (!this.#attachment) throw new Error("SDK session attachment is unavailable");
		await this.refresh();
	}

	#assertControlAttachment(attachment: sdkRouter.SessionAttachment): void {
		if (
			this.#closed ||
			this.#attachment !== attachment ||
			!attachment.isCurrent() ||
			this.#router.attachment(this.#options.id) !== attachment
		)
			throw new sdkRouter.SessionRouterError(
				"pre_send",
				"SDK owner changed before control dispatch. Select the conversation again.",
			);
	}

	async #request(
		type: "query_request" | "control_request",
		name: string,
		input: Record<string, unknown> = {},
		onDispatch?: () => void,
	): Promise<Record<string, unknown>> {
		if (this.#closed) throw new Error("Desktop session is detached");
		// Queries can synchronize a new binding. Writes belong to the exact snapshot
		// the client saw, never whichever owner the router happens to find next.
		const attachment = type === "control_request" ? this.#attachment : this.#router.attachment(this.#options.id);
		if (!attachment) throw new Error("SDK owner is unavailable");
		if (type === "control_request") this.#assertControlAttachment(attachment);
		const response = await this.#router.request(
			this.#options.id,
			{
				type,
				id: crypto.randomUUID(),
				...(type === "query_request" ? { query: name } : { operation: name }),
				input,
			},
			attachment.generation,
			attachment,
			{
				onDispatch,
				...(type === "control_request" ? { beforeDispatch: () => this.#assertControlAttachment(attachment) } : {}),
			},
		);
		if (response.ok !== true)
			throw new Error(`SDK ${name}: ${String(record(response.error)?.code ?? "invalid_response")}`);
		return response;
	}

	async #rows(query: string, input: Record<string, unknown> = {}): Promise<unknown[]> {
		// Q23 retains strings verbatim and serializes other root fields as JSON.
		// Decode the non-string fields of the query DTOs this adapter consumes.
		const jsonFields =
			query === "models.list/current"
				? ["contextWindow", "maxTokens", "reasoning", "thinking", "current"]
				: query === "transcript.list"
					? ["content", "isError"]
					: [];
		const rows: unknown[] = [];
		const cursors = new Set<string>();
		let frame: Record<string, unknown> = { type: "query_request", query, input, id: crypto.randomUUID() };
		for (let count = 0; count < 10_000; count++) {
			const attachment = this.#router.attachment(this.#options.id);
			if (!attachment) throw new Error("SDK owner is unavailable");
			const response = await this.#router.request(this.#options.id, frame, attachment.generation, attachment);
			if (response.ok !== true)
				throw new Error(`SDK ${query}: ${String(record(response.error)?.code ?? "invalid_response")}`);
			const page = record(response.page);
			if (!page || !Array.isArray(page.items)) throw new Error(`SDK ${query}: invalid page`);
			for (const item of page.items) {
				const placeholder = record(item);
				if (!placeholder?.error) {
					rows.push(item);
					continue;
				}
				if (record(placeholder.error)?.code !== "item_too_large" || !Array.isArray(placeholder.continuations))
					throw new Error(`SDK ${query}: invalid resource continuation`);
				const expanded: Record<string, unknown> = {};
				for (const value of placeholder.continuations) {
					const continuation = record(value);
					if (!continuation || typeof continuation.field !== "string")
						throw new Error("Invalid SDK resource field");
					const { query: _query, ...input } = continuation;
					const chunks = await this.#rows("resource.body", input);
					const body = chunks
						.map(chunk => {
							const data = record(chunk);
							if (typeof data?.body !== "string") throw new Error("Invalid SDK resource body");
							return data.body;
						})
						.join("");
					expanded[continuation.field] = jsonFields.includes(continuation.field) ? JSON.parse(body) : body;
				}
				rows.push(expanded);
			}
			if (page.complete === true) return rows;
			if (typeof page.continuationCursor !== "string" || cursors.has(page.continuationCursor))
				throw new Error(`SDK ${query}: invalid continuation`);
			cursors.add(page.continuationCursor);
			frame = { type: "query_request", query, input: {}, cursor: page.continuationCursor, id: crypto.randomUUID() };
		}
		throw new Error(`SDK ${query}: page limit exceeded`);
	}

	#scheduleRefresh(): void {
		if (this.#closed) return;
		this.#dirty = true;
		if (this.#timer || this.#refresh) return;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				void this.refresh().catch(() => {});
			},
			this.#deliveries.size ? 500 : 30,
		);
	}

	refresh(): Promise<void> {
		this.#dirty = true;
		this.#refresh ??= this.#refreshLoop().finally(() => {
			this.#refresh = undefined;
			if (this.#dirty) this.#scheduleRefresh();
		});
		return this.#refresh;
	}

	async #refreshLoop(): Promise<void> {
		try {
			{
				this.#dirty = false;
				const attached = this.#router.attachment(this.#options.id);
				if (!attached) throw new Error("SDK owner is unavailable");
				const captured = record((await this.#request("query_request", "session.checkpoint")).result);
				const checkpoint = record(captured?.checkpoint);
				if (
					!captured ||
					typeof captured.checkpointToken !== "string" ||
					!captured.checkpointToken ||
					!checkpoint ||
					typeof checkpoint.idle !== "boolean"
				)
					throw new Error("SDK checkpoint is unavailable");
				if (checkpoint.generation !== attached.generation) throw new Error("SDK checkpoint owner changed");
				const entries = await this.#rows("transcript.list", { checkpointToken: captured.checkpointToken });
				const metadata = record((await this.#rows("session.metadata"))[0]);
				if (metadata?.sessionId !== this.#options.id) throw new Error("SDK metadata identity mismatch");
				const models = await this.#rows("models.list/current");
				const gates = await this.#rows("workflow.gates.list");
				if (!attached.isCurrent() || this.#closed) throw new Error("SDK owner changed during snapshot");
				if (this.#attachment !== attached || this.#controlEpoch === null)
					this.#controlEpoch = this.#options.nextControlGeneration();
				this.#attachment = attached;
				this.#messages = entries.map(entry => {
					const item = record(entry);
					return item ? { ...item, content: item.content ?? item.body } : entry;
				});
				this.#models = models as Q10Model[];
				this.#title =
					typeof metadata?.name === "string" && metadata.name ? metadata.name.slice(0, 200) : this.#title;
				this.#idle = checkpoint.idle;
				this.#waiting = gates.some(gate => record(gate)?.tag === "pending");
				this.#error = undefined;
				await this.#reconcileDeliveries();
				this.#options.onChange();
			}
		} catch (error) {
			if (!this.#closed) {
				this.#error = "SDK owner could not be synchronized. Select the conversation again to retry.";
				this.#options.onChange();
			}
			throw error;
		}
	}

	async #reconcileDeliveries(): Promise<void> {
		for (const [id, selector] of this.#deliveries) {
			const response = await this.#request(
				"query_request",
				selector.kind === "steer" ? "turn.steer_status" : "turn.result",
				selector.kind === "steer"
					? { clientRef: id }
					: selector.commandId && selector.turnId
						? { kind: "prompt", commandId: selector.commandId, turnId: selector.turnId }
						: { kind: "prompt", clientRef: id },
			);
			const result = record(response.result);
			const status = result?.status;
			const disposition =
				status === "terminal_ok"
					? "completed"
					: status === "failed" || status === "rejected"
						? "failed"
						: status === "accepted" || status === "in_flight"
							? "accepted"
							: undefined;
			if (disposition) {
				await this.#options.delivery(id, {
					disposition,
					...(typeof result?.commandId === "string" ? { sdkSubmissionId: result.commandId } : {}),
				});
				if (disposition === "completed" || disposition === "failed") this.#deliveries.delete(id);
			}
		}
	}

	async prompt(id: string, text: string, deliverAs: unknown): Promise<void> {
		if (!text.trim()) throw new Error("A message is required");
		const operation = this.#idle ? "turn.prompt" : deliverAs === "followUp" ? "turn.follow_up" : "turn.steer";
		let dispatched = false;
		try {
			const response = await this.#request(
				"control_request",
				operation,
				{ text, ...(operation === "turn.follow_up" ? {} : { clientRef: id }) },
				() => {
					dispatched = true;
				},
			);
			const result = record(response.result);
			if (result?.accepted === false) throw new ManagedRefusalError("SDK input refused");
			if (result?.accepted !== true) throw new Error("SDK input admission was not confirmed");
			const commandId =
				typeof result.commandId === "string" && result.commandId.trim() ? result.commandId : undefined;
			const turnId = typeof result.turnId === "string" && result.turnId.trim() ? result.turnId : undefined;
			if (operation === "turn.follow_up" && (!commandId || !turnId))
				throw new Error("SDK follow-up receipt identity was not confirmed");
			this.#deliveries.set(id, {
				kind: operation === "turn.steer" ? "steer" : "prompt",
				...(commandId ? { commandId } : {}),
				...(turnId ? { turnId } : {}),
			});
			await this.#options.delivery(id, {
				disposition: operation === "turn.follow_up" ? "queued" : "accepted",
				...(commandId ? { sdkSubmissionId: commandId } : {}),
			});
			// Admission is already proven. A failed display refresh cannot revoke it.
			await this.refresh().catch(() => {});
		} catch (error) {
			// Never resend. A wire handoff without a durable input receipt is unknown,
			// not a refusal; the journal keeps that uncertainty across restart.
			const uncertain = dispatched && !(error instanceof ManagedRefusalError);
			if (uncertain && operation !== "turn.follow_up") {
				try {
					const recovered = record(
						(
							await this.#request(
								"query_request",
								operation === "turn.steer" ? "turn.steer_status" : "turn.result",
								operation === "turn.steer" ? { clientRef: id } : { kind: "prompt", clientRef: id },
							)
						).result,
					);
					if (
						recovered &&
						["accepted", "in_flight", "terminal_ok", "failed", "rejected"].includes(String(recovered.status))
					) {
						this.#deliveries.set(id, { kind: operation === "turn.steer" ? "steer" : "prompt" });
						await this.#reconcileDeliveries();
						this.#scheduleRefresh();
						return;
					}
				} catch {
					/* No proven receipt: retain uncertainty, never replay the input. */
				}
			}
			await this.#options.delivery(id, {
				disposition: uncertain ? "unknown" : "refused",
				error: uncertain ? "SDK input outcome unknown" : "SDK input was refused before admission",
			});
			throw error;
		}
	}

	async control(operation: string, input: Record<string, unknown> = {}): Promise<void> {
		const response = await this.#request("control_request", operation, input);
		if (operation === "turn.abort" && record(response.result)?.aborted !== true)
			throw new Error("SDK owner did not confirm stopping this client's turn");
		await this.refresh();
	}

	models(): DesktopModel[] {
		return this.#models.map(model => ({
			id: `${model.provider}/${model.id}`,
			name: model.name,
			provider: model.provider,
			contextWindow: model.contextWindow,
			reasoning: model.reasoning,
			thinking: {
				options: model.reasoning ? model.thinking.validLevels.map(level => getThinkingLevelMetadata(level)) : [],
				...(model.thinking.mode ? { mode: model.thinking.mode } : {}),
			},
		}));
	}

	async setModel(id: string, level?: unknown): Promise<void> {
		const model = this.#models.find(item => `${item.provider}/${item.id}` === id);
		if (!model) throw new Error("Model is unavailable in the SDK owner's registry");
		if (level !== undefined && !model.thinking.validLevels.some(option => option === level))
			throw new Error("Unsupported thinking level");
		return this.control("model.set", { id, ...(level === undefined ? {} : { thinkingLevel: level }) });
	}

	async setThinking(value: unknown): Promise<void> {
		const level = typeof value === "string" ? parseThinkingLevel(value) : undefined;
		const model = this.#models.find(item => item.current);
		if (level === undefined || !model?.reasoning || !model.thinking.validLevels.some(option => option === level))
			throw new Error("Unsupported thinking level");
		return this.control("thinking.set", { level });
	}

	#entryIds(messages: DesktopMessage[]): DesktopMessage[] {
		return messages.map(message => {
			const index = Number(message.id.split(":", 1)[0]);
			const entry = record(this.#messages[index]);
			return typeof entry?.id === "string" ? { ...message, id: entry.id, entryId: entry.id } : message;
		});
	}

	dto(messageBudget = 2_000_000): DesktopSession {
		const projected = fitMessages(
			this.#entryIds(projectMessages(this.#messages, this.#options.redact)),
			messageBudget,
		);
		const model = this.#models.find(item => item.current);
		return {
			id: this.#options.id,
			projectId: this.#options.projectId,
			title: this.#title,
			starred: this.#options.starred,
			status: this.#waiting
				? "waiting"
				: this.#error
					? "error"
					: !this.#idle
						? "running"
						: projected.messages.length
							? "done"
							: "idle",
			messages: projected.messages,
			operatorRunning: false,
			...(projected.truncated || countVisibleMessages(this.#messages) > HISTORY_LIMIT
				? { historyTruncated: true }
				: {}),
			controlGeneration: this.controlGeneration,
			imageInput: null,
			...(model ? { model: `${model.provider}/${model.id}` } : {}),
			thinking: {
				level: model?.currentThinkingLevel ?? null,
				options: model?.reasoning ? model.thinking.validLevels.map(level => getThinkingLevelMetadata(level)) : [],
				scope: null,
				available: !!model?.reasoning && !!model.thinking.validLevels.length,
				...(model?.thinking.mode ? { mode: model.thinking.mode } : {}),
			},
			...(this.#error || this.#waiting ? { error: this.#error ?? unavailableInteraction } : {}),
		};
	}

	history(offset: number, limit: number): DesktopHistory {
		const { total, page, truncated } = projectHistoryPage(this.#messages, offset, limit, this.#options.redact);
		return { sessionId: this.#options.id, total, offset, messages: this.#entryIds(page), truncated };
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#timer) clearTimeout(this.#timer);
		await this.#router.stop();
		await this.#refresh?.catch(() => {});
	}
}
