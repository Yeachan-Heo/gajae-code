/** Browser-safe session information. No SDK, provider, filesystem, or credential types. */
export interface DesktopSessionInfoUnavailable {
	available: false;
	reason: string;
}

/** Null buckets are missing, invalid, or outside exact safe-integer precision; never coerced to zero. */
export interface DesktopSessionInfoTokens {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	total: number | null;
}

export interface DesktopSessionInfoCost {
	/** SDK-recorded cost, not an invoice or an account balance. Zero without pricing provenance is unknown. */
	amount: number | null;
	source: "sdk_recorded_cost" | "live_partial_cost";
	reason: string;
}

export interface DesktopSessionInfoUsage {
	available: true;
	source: "transcript_aggregate" | "active_messages" | "stream_partial";
	note: string;
	tokens: DesktopSessionInfoTokens;
	/** Null when the SDK does not distinguish an absent counter from zero. */
	premiumRequests: number | null;
	cost: DesktopSessionInfoCost;
}

export interface DesktopSessionInfoContext {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	source: "provider_anchor" | "heuristic" | "unknown";
	/** Even provider_anchor includes a heuristic trailing delta; this is not billed usage. */
	note: string;
}

export type DesktopSessionInfo =
	| (DesktopSessionInfoUnavailable & {
		code: "disposed" | "transitioning" | "stale_session" | "backend_failure" | "redaction_failed" | "invalid_catalog_session";
	})
	| {
		available: true;
		metadata: {
			/** Exact host-owned app catalog identity; never an SDK session/owner identity. */
			catalogSessionId: string;
			name: string | null;
			/** Redacted display text only; not a native path, file selector, or capability. */
			sessionFileDisplay: string | null;
			cwd: string;
			createdAt: string | null;
			/** Persistence is enabled; this does not certify that pending writes have flushed. */
			persisted: boolean;
		};
		model: { provider: string; id: string; name: string } | null;
		thinkingLevel: string | null;
		run: {
			state: "running" | "compacting" | "retrying" | "settling" | "idle";
			streaming: boolean;
			/** SDK raw-executor activity, not a process ledger or physical termination proof. */
			bashRunning: boolean;
			pythonRunning: boolean;
			compacting: boolean;
			retrying: boolean;
			postPromptWork: boolean;
			queuedMessages: number | null;
		};
		tools: {
			available: number | null;
			pending: number | null;
			/** Calls/results in the active message list, not the whole persisted tree. */
			calls: number | null;
			results: number | null;
		};
		/** All transcript assistant/task usage, including inactive branches; may not yet be flushed to disk. */
		recordedTotals: DesktopSessionInfoUsage | DesktopSessionInfoUnavailable;
		/** getSessionStats totals over the active in-memory message list, excluding the streaming partial. */
		activeTotals: DesktopSessionInfoUsage | DesktopSessionInfoUnavailable;
		/** Provisional SDK counters only; never added to recordedTotals or treated as billed usage. */
		liveProgress: DesktopSessionInfoUsage | DesktopSessionInfoUnavailable;
		context: DesktopSessionInfoContext;
		accountQuota: DesktopSessionInfoUnavailable;
		actualBilledCost: DesktopSessionInfoUnavailable;
	};
