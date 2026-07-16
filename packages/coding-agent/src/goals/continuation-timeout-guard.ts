export type ToolOutcomeKind = "timeout" | "success" | "other-error";

export interface TimeoutToolOutcome {
	toolName: string;
	argsKey: string;
	kind: ToolOutcomeKind;
}

export interface TimeoutHoldState {
	heldSnapshotKey?: string;
	fingerprint?: string;
	streak: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeArgs(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeArgs(item));
	}
	if (isRecord(value)) {
		const canonical: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] !== undefined) {
				canonical[key] = canonicalizeArgs(value[key]);
			}
		}
		return canonical;
	}
	return value;
}

export function toResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				isRecord(content) && content.type === "text" && typeof content.text === "string",
		)
		.map(content => content.text)
		.join("\n");
}

export function classifyToolOutcome(isError: unknown, text: string): ToolOutcomeKind {
	if (isError !== true) return "success";
	return /\btimed out\b|\btimeout\b/i.test(text) ? "timeout" : "other-error";
}

export function canonicalArgsKey(args: unknown): string {
	return JSON.stringify(canonicalizeArgs(args ?? null)) ?? "null";
}

export function turnTimeoutFingerprint(outcomes: readonly TimeoutToolOutcome[]): string | null {
	if (outcomes.length === 0 || outcomes.some(outcome => outcome.kind !== "timeout")) return null;
	const [first] = outcomes;
	if (!first || outcomes.some(outcome => outcome.toolName !== first.toolName || outcome.argsKey !== first.argsKey)) {
		return null;
	}
	return `${first.toolName}\u0000${first.argsKey}`;
}

export function decideTimeoutHold(
	prev: TimeoutHoldState,
	turn: { snapshotKey: string; fingerprint: string | null },
): { hold: boolean; next: TimeoutHoldState } {
	if (turn.fingerprint === null) {
		return { hold: false, next: { heldSnapshotKey: undefined, fingerprint: undefined, streak: 0 } };
	}
	const continues =
		prev.streak >= 1 && prev.fingerprint === turn.fingerprint && prev.heldSnapshotKey === turn.snapshotKey;
	const streak = continues ? prev.streak + 1 : 1;
	return {
		hold: streak >= 2,
		next: { heldSnapshotKey: turn.snapshotKey, fingerprint: turn.fingerprint, streak },
	};
}
