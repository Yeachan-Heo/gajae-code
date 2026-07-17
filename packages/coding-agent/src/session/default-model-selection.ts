import type { ResolvedThinkingLevel } from "@gajae-code/agent-core";
import { isRecord } from "@gajae-code/utils";

export type DefaultModelSelectionRollbackStage = "durable" | "session" | "live";

export const DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE =
	"Default model selection could not be completed after durable selection.";

export type DefaultModelSelectionRecovery = {
	readonly message: string;
	readonly rollback: {
		readonly disposition: "restored" | "partial" | "unknown";
		readonly failures: readonly {
			readonly stage: DefaultModelSelectionRollbackStage;
			readonly message: string;
		}[];
	};
};

export interface DefaultModelSelectionResult {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ResolvedThinkingLevel;
}

const recoveryMessages: Readonly<
	Record<DefaultModelSelectionRollbackStage, { readonly fallback: string; readonly allowed: ReadonlySet<string> }>
> = {
	durable: {
		fallback: "Durable default selection recovery could not be completed.",
		allowed: new Set([
			"A newer default selection prevented durable recovery.",
			"Durable default selection recovery could not be completed.",
		]),
	},
	session: {
		fallback: "Session replacement recovery could not be completed.",
		allowed: new Set([
			"Session replacement recovery could not be completed.",
			"Session replacement outcome could not be determined.",
		]),
	},
	live: {
		fallback: "Live model publication could not be completed.",
		allowed: new Set(["Live model publication could not be completed."]),
	},
};

export function parseDefaultModelSelectionRecovery(value: unknown): DefaultModelSelectionRecovery | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.message !== "string" || !value.message.trim()) return undefined;
	if (!isRecord(value.rollback)) return undefined;
	const disposition = value.rollback.disposition;
	if (disposition !== "restored" && disposition !== "partial" && disposition !== "unknown") return undefined;
	if (!Array.isArray(value.rollback.failures) || value.rollback.failures.length > 3) return undefined;

	const seenStages = new Set<DefaultModelSelectionRollbackStage>();
	const failures: DefaultModelSelectionRecovery["rollback"]["failures"][number][] = [];
	for (const failure of value.rollback.failures) {
		if (!isRecord(failure)) return undefined;
		const stage = failure.stage;
		if (
			(stage !== "durable" && stage !== "session" && stage !== "live") ||
			typeof failure.message !== "string" ||
			!failure.message.trim() ||
			seenStages.has(stage)
		)
			return undefined;
		seenStages.add(stage);
		const messages = recoveryMessages[stage];
		failures.push({
			stage,
			message: messages.allowed.has(failure.message) ? failure.message : messages.fallback,
		});
	}

	return { message: DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE, rollback: { disposition, failures } };
}

export class DefaultModelSelectionRecoveryError extends Error {
	readonly name = "DefaultModelSelectionRecoveryError";
	readonly code = "default_model_selection_recovery";
	readonly recovery: DefaultModelSelectionRecovery;

	constructor(_message: string, recovery: DefaultModelSelectionRecovery) {
		const publicRecovery = parseDefaultModelSelectionRecovery(recovery) ?? {
			message: DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE,
			rollback: { disposition: "unknown" as const, failures: [] },
		};
		super(publicRecovery.message);
		this.recovery = publicRecovery;
	}
}
