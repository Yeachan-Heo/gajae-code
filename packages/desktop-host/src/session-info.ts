import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type {
	DesktopSessionInfo,
	DesktopSessionInfoContext,
	DesktopSessionInfoTokens,
	DesktopSessionInfoUnavailable,
	DesktopSessionInfoUsage,
} from "./session-info-protocol";

/** fieldChars counts Unicode code points, plus at most one truncation ellipsis. */
export const DESKTOP_SESSION_INFO_LIMITS = { fieldChars: 512, inputChars: 65_536 } as const;

export interface DesktopSessionInfoOptions {
	/** Required opaque identity from the owning host's app catalog, never supplied by the SDK. */
	catalogSessionId: string;
	/** Host-known secret/path/identity policy. Applied to complete fields before display truncation. */
	redact: (text: string) => string;
}

const FAILURE_REASONS = {
	invalid_catalog_session: "A valid host-owned app catalog session identity is required.",
	disposed: "Session information is unavailable after disposal.",
	transitioning: "Session information is temporarily unavailable during a session transition.",
	stale_session: "The session changed while reading information; refresh the view.",
	backend_failure: "Session information could not be read from the public SDK.",
	redaction_failed: "Session information redaction failed; no content was returned.",
} as const;

type FailureCode = keyof typeof FAILURE_REASONS;

function failure(code: FailureCode): DesktopSessionInfo {
	return { available: false, code, reason: FAILURE_REASONS[code] };
}

function unavailable(reason: string): DesktopSessionInfoUnavailable {
	return { available: false, reason };
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function amount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
		? value : null;
}

function read<T>(operation: () => T): T | undefined {
	try { return operation(); } catch { return undefined; }
}

class RedactionFailure extends Error {}

function text(value: unknown, redact: DesktopSessionInfoOptions["redact"]): string {
	if (typeof value !== "string") throw new RedactionFailure();
	// Withhold overlarge metadata in full: never truncate a secret before redacting it.
	if (value.length > DESKTOP_SESSION_INFO_LIMITS.inputChars) return "[withheld: display limit]";
	let redacted: unknown;
	try { redacted = redact(value); } catch { throw new RedactionFailure(); }
	if (typeof redacted !== "string") throw new RedactionFailure();
	if (redacted.length > DESKTOP_SESSION_INFO_LIMITS.inputChars) return "[withheld: display limit]";
	const safe = redacted.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ");
	let result = "";
	let length = 0;
	for (const character of safe) {
		if (length++ === DESKTOP_SESSION_INFO_LIMITS.fieldChars) return `${result}…`;
		result += character;
	}
	return result;
}

interface UsageNumbers {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	premiumRequests?: number;
	cost: number;
}

function usage(raw: UsageNumbers | undefined, source: DesktopSessionInfoUsage["source"]): DesktopSessionInfoUsage | DesktopSessionInfoUnavailable {
	if (!raw) return unavailable("The public SDK could not provide these usage counters.");
	const tokens: DesktopSessionInfoTokens = {
		input: count(raw.input), output: count(raw.output), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite), total: null,
	};
	const buckets = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite];
	if (buckets.every(bucket => bucket !== null)) tokens.total = count(buckets.reduce<number>((sum, bucket) => sum + (bucket ?? 0), 0));
	// Provider adapters initialize counters to zero before any usage is reported.
	// Neither a fresh stream nor an empty/legacy transcript proves measured zero usage.
	const cost = amount(raw.cost);
	const premiumRequests = amount(raw.premiumRequests);
	if (
		!buckets.some(bucket => bucket !== null && bucket > 0) &&
		!(cost !== null && cost > 0) && !(premiumRequests !== null && premiumRequests > 0)
	) {
		return unavailable("No usable positive usage is available; SDK zero defaults or invalid values do not establish measured usage or cost.");
	}
	const provisional = source === "stream_partial";
	return {
		available: true, source, tokens,
		note: source === "transcript_aggregate"
			? "SDK aggregate of recorded assistant and task usage across the transcript, including inactive branches; excludes live partials and may include legacy defaults or partial/error turns. Not proof of a disk flush or complete billing."
			: provisional
				? "Provisional stream counters; may be incomplete or initialized defaults. Not billed usage and not included in recorded totals."
				: "SDK totals over active in-memory messages, including task usage and partial/error turns; excludes the streaming partial and compacted or inactive history. Not complete session billing.",
		premiumRequests: premiumRequests !== null && premiumRequests > 0 ? premiumRequests : null,
		cost: {
			amount: cost !== null && cost > 0 ? cost : null,
			source: provisional ? "live_partial_cost" : "sdk_recorded_cost",
			reason: cost !== null && cost > 0
				? "SDK-recorded cost may be model-priced or partial; it is not actual billed cost."
				: "The SDK does not establish pricing provenance for a zero or missing cost; cost is unknown.",
		},
	};
}

function context(session: AgentSession): DesktopSessionInfoContext {
	const value = read(() => session.getContextUsage());
	if (!value) return {
		tokens: null, contextWindow: null, percent: null, source: "unknown",
		note: "Current context usage is unavailable: no usable model context window or SDK estimate.",
	};
	const contextWindow = count(value.contextWindow);
	const source = value.source === "provider_anchor" || value.source === "heuristic" ? value.source : "unknown";
	const tokens = source === "unknown" ? null : count(value.tokens);
	return {
		tokens, contextWindow: contextWindow && contextWindow > 0 ? contextWindow : null,
		percent: tokens !== null && contextWindow && contextWindow > 0 ? amount(value.percent) : null,
		source,
		note: source === "provider_anchor"
			? "Current context estimate anchored on a prior provider response plus heuristic trailing changes; not cumulative usage or billing."
			: source === "heuristic"
				? "Heuristic current context estimate, not a provider-measured token count or billed usage."
				: "Context token count is unknown until a response after compaction supplies a usable usage anchor.",
	};
}

/**
 * Synchronous, live-safe observation only. No mutation lease, idle wait, prompt,
 * persistence flush, global manager, registry refresh, or provider/account probe.
 * The sole user callback runs after SDK reads; lifecycle is checked again afterward.
 */
export function readDesktopSessionInfo(session: AgentSession, options: DesktopSessionInfoOptions): DesktopSessionInfo {
	try {
		const catalogSessionId: unknown = options?.catalogSessionId;
		// The host must resolve catalog membership before calling. This guard only
		// validates identity shape; it never authorizes a renderer ownership claim.
		if (typeof catalogSessionId !== "string" || /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.exec(catalogSessionId)?.[0] !== catalogSessionId) {
			return failure("invalid_catalog_session");
		}
		const lifecycle = session.sessionLifecycle;
		if (lifecycle.disposed) return failure("disposed");
		if (lifecycle.transitioning) return failure("transitioning");
		const manager = session.sessionManager;
		const sessionId = session.sessionId;
		const managerSessionId = manager.getSessionId();
		const credentialSessionId = session.credentialSessionId;
		const agentId = session.getAgentId();
		const identities = [...new Set([sessionId, managerSessionId, credentialSessionId, agentId])]
			.filter((identity): identity is string => typeof identity === "string" && identity.length > 0)
			.sort((left, right) => right.length - left.length);
		if (identities.some(identity => catalogSessionId.includes(identity))) return failure("invalid_catalog_session");
		const stats = read(() => session.getSessionStats());
		const recorded = read(() => {
			const value = manager.getUsageStatistics();
			return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, premiumRequests: value.premiumRequests, cost: value.cost };
		});
		const active = stats ? { ...stats.tokens, premiumRequests: stats.premiumRequests, cost: stats.cost } : undefined;
		const state = session.state;
		const partial = read(() => {
			if (!session.isStreaming || state.streamMessage?.role !== "assistant") return undefined;
			const value = state.streamMessage.usage;
			return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, premiumRequests: value.premiumRequests, cost: value.cost?.total };
		});
		const rawModel = session.model;
		const model = rawModel ? { provider: rawModel.provider, id: rawModel.id, name: rawModel.name } : null;
		const metadata = {
			name: session.sessionName ?? null, sessionFile: session.sessionFile ?? null,
			cwd: manager.getCwd(), createdAt: manager.getHeader()?.timestamp ?? null, persisted: manager.isPersisted(),
		};
		const thinkingLevel = session.thinkingLevel ?? null;
		const streaming = session.isStreaming;
		const bashRunning = session.isBashRunning;
		const pythonRunning = session.isEvalRunning;
		const compacting = session.isCompacting;
		const retrying = session.isRetrying;
		const postPromptWork = session.hasPostPromptWork;
		const runState = compacting ? "compacting" : retrying ? "retrying" : streaming || bashRunning || pythonRunning ? "running" : postPromptWork ? "settling" : "idle";
		const result: DesktopSessionInfo = {
			available: true,
			metadata: { catalogSessionId, name: null, sessionFileDisplay: null, cwd: "", createdAt: null, persisted: metadata.persisted },
			model: null, thinkingLevel: null,
			run: { state: runState, streaming, bashRunning, pythonRunning, compacting, retrying, postPromptWork, queuedMessages: count(session.queuedMessageCount) },
			tools: { available: count(state.tools.length), pending: count(state.pendingToolCalls.size), calls: count(stats?.toolCalls), results: count(stats?.toolResults) },
			recordedTotals: usage(recorded, "transcript_aggregate"), activeTotals: usage(active, "active_messages"),
			liveProgress: partial ? usage(partial, "stream_partial") : unavailable("No assistant stream usage is currently observable."),
			context: context(session),
			accountQuota: unavailable("Account quota is not exposed by these session reads; no provider or account endpoint was queried."),
			actualBilledCost: unavailable("The public session API does not expose invoices or actual billed usage; SDK-recorded costs are not billing evidence."),
		};
		const redact = options.redact;
		const maskIdentities = (value: string): string => {
			let masked = value;
			for (const identity of identities) masked = masked.replaceAll(identity, "[session]");
			return masked;
		};
		// SDK identities are not display identities, even with an identity host redactor.
		// Mask on both sides of the callback so it cannot reintroduce a captured ID.
		const redactMetadata = (value: string): string => {
			const redacted: unknown = redact(maskIdentities(value));
			if (typeof redacted !== "string") throw new RedactionFailure();
			return maskIdentities(redacted);
		};
		result.metadata = {
			catalogSessionId, name: metadata.name === null ? null : text(metadata.name, redactMetadata),
			sessionFileDisplay: metadata.sessionFile === null ? null : text(metadata.sessionFile, redactMetadata), cwd: text(metadata.cwd, redactMetadata),
			createdAt: metadata.createdAt === null ? null : text(metadata.createdAt, redactMetadata), persisted: metadata.persisted,
		};
		// Provider/model identities remain real metadata; only captured SDK ownership
		// identities and the host's known secrets are masked, not provider IDs as a class.
		result.model = model ? { provider: text(model.provider, redactMetadata), id: text(model.id, redactMetadata), name: text(model.name, redactMetadata) } : null;
		result.thinkingLevel = thinkingLevel === null ? null : text(thinkingLevel, redactMetadata);
		const current = session.sessionLifecycle;
		if (current.disposed) return failure("disposed");
		if (
			current.generation !== lifecycle.generation || session.sessionManager !== manager || session.sessionId !== sessionId ||
			manager.getSessionId() !== managerSessionId || session.credentialSessionId !== credentialSessionId || session.getAgentId() !== agentId
		) return failure("stale_session");
		if (current.transitioning) return failure("transitioning");
		return result;
	} catch (error) {
		return failure(error instanceof RedactionFailure ? "redaction_failed" : "backend_failure");
	}
}
