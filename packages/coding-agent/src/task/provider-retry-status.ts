import type { AgentProgress, TaskToolDetails } from "./types";

export type ProviderRetryKind = NonNullable<AgentProgress["retryState"]>["kind"];

const FIRST_EVENT_TIMEOUT_PATTERN = /stream timed out while waiting for the first event/i;
const FIRST_EVENT_TIMEOUT_WITHOUT_ARTICLE_MESSAGE = "Provider stream timed out while waiting for first event";
const IDLE_STREAM_STALL_PATTERN = /stream stalled while waiting for the next event/i;
const STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE = "stream_first_event_timeout";

export function classifyProviderRetry(errorMessage: string): ProviderRetryKind {
	return classifyProviderRetryFromTransport({ errorMessage });
}

/**
 * Prefer typed transport facts when present; fall back to message regex for
 * message-only callers that never received `transportFailure.providerCode`.
 */
export function classifyProviderRetryFromTransport(facts: {
	providerCode?: string;
	errorMessage?: string;
}): ProviderRetryKind {
	if (facts.providerCode?.toLowerCase() === STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE) {
		return "first_event_timeout";
	}
	const errorMessage = facts.errorMessage ?? "";
	if (FIRST_EVENT_TIMEOUT_PATTERN.test(errorMessage) || errorMessage === FIRST_EVENT_TIMEOUT_WITHOUT_ARTICLE_MESSAGE) {
		return "first_event_timeout";
	}
	if (IDLE_STREAM_STALL_PATTERN.test(errorMessage)) return "idle_stream_stall";
	return "provider_error";
}

export function providerNameFromModel(model: string | undefined): string | undefined {
	const provider = model?.split("/", 1)[0]?.trim();
	return provider || undefined;
}

export function providerRetryPhaseLabel(kind: ProviderRetryKind): string {
	switch (kind) {
		case "first_event_timeout":
			return "first event timeout";
		case "idle_stream_stall":
			return "stream stalled";
		case "provider_error":
			return "provider error";
	}
}

export function providerProgressAgeLabel(retryState: NonNullable<AgentProgress["retryState"]>, nowMs: number): string {
	if (retryState.lastProviderProgressAtMs === undefined) return "no provider events yet";
	const ageSeconds = Math.max(0, Math.floor((nowMs - retryState.lastProviderProgressAtMs) / 1000));
	return `last provider progress ${ageSeconds}s ago`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		isRecord(value) && Array.isArray(value.results) && (value.progress === undefined || Array.isArray(value.progress))
	);
}

function isAgentProgress(value: unknown): value is AgentProgress {
	return isRecord(value) && typeof value.status === "string";
}

export function hasActiveProviderRetryInTaskDetails(details: TaskToolDetails, seen = new WeakSet<object>()): boolean {
	if (!isTaskToolDetails(details) || seen.has(details)) return false;
	seen.add(details);
	for (const progress of details.progress ?? []) {
		if (isAgentProgress(progress) && hasActiveProviderRetryInProgress(progress, seen)) return true;
	}
	return false;
}

export function hasActiveProviderRetryInProgress(progress: AgentProgress, seen = new WeakSet<object>()): boolean {
	if (!isAgentProgress(progress) || seen.has(progress)) return false;
	seen.add(progress);
	if (progress.status === "running" && progress.retryState) return true;

	const nestedTaskData = isRecord(progress.extractedToolData) ? progress.extractedToolData.task : undefined;
	if (Array.isArray(nestedTaskData)) {
		for (const nestedDetails of nestedTaskData) {
			if (hasActiveProviderRetryInTaskDetails(nestedDetails as TaskToolDetails, seen)) return true;
		}
	}
	return hasActiveProviderRetryInTaskDetails(progress.inflightTaskDetails as TaskToolDetails, seen);
}

export interface ProviderDegradationGroup {
	provider: string;
	count: number;
}

export function collectProviderDegradationGroups(progress: readonly AgentProgress[]): ProviderDegradationGroup[] {
	const counts = new Map<string, number>();
	for (const item of progress) {
		if (!isAgentProgress(item) || item.status !== "running" || !item.retryState) continue;
		const provider = item.retryState.provider ?? "provider";
		counts.set(provider, (counts.get(provider) ?? 0) + 1);
	}
	return Array.from(counts, ([provider, count]) => ({ provider, count }))
		.filter(group => group.count > 1)
		.sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}
