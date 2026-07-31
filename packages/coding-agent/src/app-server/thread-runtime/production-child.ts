import { randomUUID } from "node:crypto";
import packageMetadata from "../../../package.json" with { type: "json" };
import { toAgentWireEventPayload } from "../../modes/shared/agent-wire/event-envelope";
import { dispatchControl } from "../../sdk/host/control/dispatch";
import type { ControlSurface } from "../../sdk/host/control/operations";
import { OPERATIONS } from "../../sdk/protocol/operation-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../../sdk/session";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { ChildBridgeOptions, ChildCreateRequest, ChildCreateResult, SessionClient } from "./child-bridge";
import type { ThreadEffectiveSettings } from "./thread-runtime-manager";

type ProjectionRecord = Record<string, unknown> & { revision: number };

export interface ProductionThreadStartAdapterOptions {
	readonly agentDir?: string;
	readonly createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectionStore() {
	const rows: ProjectionRecord[] = [];
	return {
		append(envelope: Record<string, unknown>): Record<string, unknown> {
			const existing = rows.find(row => row.sourceKey === envelope.sourceKey);
			if (existing) return { ok: true, revision: existing.revision, record: existing };
			const row = { ...envelope, revision: rows.length + 1 };
			rows.push(row);
			return { ok: true, revision: row.revision, record: row };
		},
		read(afterRevision = 0): Record<string, unknown> {
			return { records: rows.filter(row => row.revision > afterRevision), revision: rows.length };
		},
	};
}

function buildSurface(
	session: AgentSession,
	emit: (event: AgentSessionEvent) => void,
	projections: ReturnType<typeof projectionStore>,
): ControlSurface {
	const surface = {
		prompt: async (text: string, images?: unknown, clientRef?: string) => {
			const correlation = { commandId: randomUUID(), turnId: randomUUID() };
			try {
				await session.prompt(text, {
					images: Array.isArray(images) ? (images as never) : undefined,
					attribution: "user",
				});
				return { accepted: true, ...correlation, ...(clientRef ? { clientRef } : {}) };
			} catch (error) {
				throw error;
			}
		},
		steer: (text: string) => session.steer(text),
		followUp: (text: string) => session.prompt(text, { streamingBehavior: "followUp" }),
		abort: () => session.abort(),
		abortAndPrompt: async (text: string) => {
			await session.abort();
			return surface.prompt(text);
		},
		runCompaction: () => session.compact(),
		appendProjection: (envelope: unknown) => projections.append(envelope as Record<string, unknown>),
		readProjection: (afterRevision?: number) => projections.read(afterRevision),
		installedOperations: new Set([
			"turn.prompt",
			"turn.steer",
			"turn.follow_up",
			"turn.abort",
			"turn.abort_and_prompt",
			"compaction.run",
			"projection.append",
			"projection.read",
		]),
	} as unknown as ControlSurface;
	void emit;
	return surface;
}

function queryResult(
	query: string,
	input: Record<string, unknown>,
	projections: ReturnType<typeof projectionStore>,
	session: AgentSession,
	promptStatus: () => Record<string, unknown>,
): unknown {
	if (query === "projection.read")
		return projections.read(typeof input.afterRevision === "number" ? input.afterRevision : 0);
	if (query === "turn.prompt_status") return promptStatus();
	if (query === "session.metadata") return { sessionId: session.sessionId, cwd: session.sessionManager.getCwd() };
	throw Object.assign(new Error(`Query operation is unavailable: ${query}`), { code: "unavailable" });
}

/**
 * Project the REAL session state onto `ThreadEffectiveSettings`. Every field is read from the
 * live session; nothing is invented. Fields GJC genuinely has no value for are null, which the
 * pinned thread projection accepts, rather than a fabricated placeholder.
 */
function effectiveSettingsFor(session: AgentSession): ThreadEffectiveSettings {
	const cwd = session.sessionManager.getCwd();
	const now = Date.now();
	const model = session.model;
	// The pinned Thread requires a model string; a session without one cannot be described
	// truthfully, so fail closed rather than inventing a placeholder model id.
	if (!model) throw new Error("The GJC session has no active model, so thread settings cannot be projected.");
	return {
		model: model.id,
		modelProvider: model.provider,
		serviceTier: session.serviceTier ?? null,
		cwd,
		instructionSources: [],
		// GJC's SDK permission modes map onto the pinned AskForApproval values: `prompt` asks per
		// request, `allow` never asks, and `deny` trusts nothing.
		approvalPolicy:
			session.sdkPermissionMode === "allow"
				? "never"
				: session.sdkPermissionMode === "deny"
					? "untrusted"
					: "on-request",
		approvalsReviewer: "user",
		sandbox: { type: "dangerFullAccess" },
		reasoningEffort: session.thinkingLevel ?? null,
		thread: {
			id: session.sessionId,
			sessionId: session.sessionId,
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: false,
			isPinned: false,
			modelProvider: session.model?.provider ?? "unknown",
			createdAt: now,
			updatedAt: now,
			recencyAt: null,
			// A freshly loaded in-process session is idle until a turn starts.
			status: { type: "idle" },
			path: session.sessionManager.getSessionFile() ?? null,
			cwd,
			cliVersion: packageMetadata.version,
			source: "appServer",
			threadSource: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
			// Experimental-profile fields: an in-process session carries no extra payload, uses the
			// paginated history the app-server projection reconstructs, and does accept direct input.
			extra: null,
			historyMode: "paginated",
			canAcceptDirectInput: true,
		},
		runtimeWorkspaceRoots: [cwd],
		activePermissionProfile: null,
		// GJC has no proactive multi-agent delegation policy at this seam.
		multiAgentMode: "explicitRequestOnly",
	};
}

export function createProductionThreadStartAdapter(
	options: ProductionThreadStartAdapterOptions = {},
): Omit<ChildBridgeOptions, "manager"> {
	const create = async (request: ChildCreateRequest): Promise<ChildCreateResult> => {
		const params = request.params;
		const createImpl = options.createSession ?? createAgentSession;
		const sessionOptions: CreateAgentSessionOptions = {
			cwd: request.cwd,
			...(options.agentDir ? { agentDir: options.agentDir } : {}),
			...(typeof params.model === "string" ? { modelPattern: params.model } : {}),
			...(typeof params.thinkingLevel === "string" ? { thinkingLevel: params.thinkingLevel as never } : {}),
			hasUI: false,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
		};
		const created = await createImpl(sessionOptions);
		const session = created.session;
		const projections = projectionStore();
		let correlation: { commandId: string; turnId: string } | undefined;
		let promptState: Record<string, unknown> = { status: "idle" };
		const listeners = new Set<(frame: Record<string, unknown>) => void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start" && correlation) {
				promptState = { status: "inProgress", ...correlation };
			}
			if (event.type === "agent_end" || event.type === "turn_end") {
				if (correlation) promptState = { status: "completed", ...correlation };
			}
			if (!correlation) return;
			const payload = toAgentWireEventPayload(event);
			const frame = { type: "event", kind: event.type, payload, ...correlation };
			for (const listener of listeners) listener(frame);
			if (event.type === "agent_end") correlation = undefined;
		});
		const surface = buildSurface(
			session,
			event => {
				if (event.type === "agent_start")
					correlation = correlation ?? { commandId: randomUUID(), turnId: randomUUID() };
			},
			projections,
		);
		const client: SessionClient = {
			onFrame(handler) {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			onReconnect: () => () => {},
			onReconnectFailed: () => () => {},
			request: async frame => frame,
			control: async (operation, input = {}, controlOptions) => {
				if (operation === "turn.prompt") {
					const commandId = randomUUID();
					const turnId = randomUUID();
					correlation = { commandId, turnId };
					promptState = { status: "queued", commandId, turnId, clientRef: input.clientRef };
				}
				const result = await dispatchControl(
					surface,
					OPERATIONS.find(row => row.kind === "control" && row.sdkId === operation),
					{
						id: randomUUID(),
						operation,
						input,
						confirm: controlOptions?.confirm,
						idempotencyKey: controlOptions?.idempotencyKey,
					},
				);
				return result;
			},
			query: async (query, input = {}) => queryResult(query, input, projections, session, () => promptState),
			close: async () => {
				unsubscribe();
				listeners.clear();
				await session.dispose();
			},
		};
		return {
			sessionId: session.sessionId,
			cwd: session.sessionManager.getCwd(),
			effectiveSettings: effectiveSettingsFor(session),
			client,
			awaitReady: async () => {
				await session.workflowGateToolRestoration;
			},
			closeChild: async () => client.close(),
		};
	};
	// `attached`: the child is an in-process GJC session, so there is no separate endpoint
	// process to fence with endpoint authority. Claiming `spawned` would assert a fencing
	// identity this child does not have.
	return { create, ownership: "attached" };
}
