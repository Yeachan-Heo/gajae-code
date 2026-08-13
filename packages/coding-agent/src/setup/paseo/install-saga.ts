/**
 * Four-step install saga with reverse-order compensation.
 *
 * GJC writes to four files it does not own, across two applications, with no
 * distributed lock available. Nothing here can be made atomic across files, so
 * the design is instead: refuse early, record enough to recover, and undo in
 * reverse on failure.
 *
 * Forward order is fixed:
 *   1. `~/.paseo/config.json` provider entry + provider-key provenance
 *   2. `~/.paseo/orchestration-preferences.json` seeded roles + seeded-key provenance
 *   3. `<agentDir>/paseo-skills/` symlink bridge
 *   4. `~/.gjc/agent/config.yml` `skills.customDirectories` append
 *
 * Steps 1 and 2 each mutate a Paseo file AND the GJC provenance ledger. Those
 * are separate files, so a durable intent record is written BEFORE either one,
 * carrying preflight and expected-post identities for BOTH. Recovery classifies
 * each file independently and refuses whenever the ledger diverged.
 */
import type { CasReceipt } from "../../config/atomic-yaml-patch";
import { currentIdentity, hashBytes, planPublish, publishPlan, readTarget } from "./json-publisher";
import {
	classifyIntent,
	clearIntent,
	INTENT_VERSION,
	type IntentRecord,
	type IntentStep,
	type ProvenanceLedger,
	pendingLedgerOf,
	readIntent,
	readProvenance,
	writeIntent,
	writeProvenance,
} from "./paseo-ownership";
import type { PartialInstallEvidence } from "./result-types";

/** One completed forward step, retaining exactly what its inverse needs. */
export interface CompletedStep {
	readonly label: string;
	/** Undo this step. Resolves to `"reverted"`, or `"conflict"` when the resource moved underneath us. */
	undo(): Promise<StepUndoResult>;
}

export type StepUndoResult =
	| { readonly status: "reverted" }
	| { readonly status: "conflict"; readonly detail: string; readonly retained: readonly string[] };

export class SagaStepError extends Error {
	readonly label: string;
	readonly retained: readonly string[];

	constructor(label: string, message: string, retained: readonly string[] = []) {
		super(message);
		this.name = "SagaStepError";
		this.label = label;
		this.retained = retained;
	}
}

export interface CompensationOutcome {
	readonly compensated: readonly string[];
	readonly uncompensated: readonly string[];
	readonly evidence: PartialInstallEvidence;
}

/**
 * Undo completed steps newest-first, halting at the first inverse that reports
 * a conflict.
 *
 * Halting is deliberate: once one resource has diverged, continuing to unwind
 * the others would leave a stranger mix of reverted and live state that no
 * later run could interpret. Stopping preserves an interpretable prefix.
 */
export async function compensate(
	completed: readonly CompletedStep[],
	failure: SagaStepError,
): Promise<CompensationOutcome> {
	const compensated: string[] = [];
	const uncompensated: string[] = [];
	const retained = [...failure.retained];
	let conflictDetail: string | undefined;

	for (let index = completed.length - 1; index >= 0; index--) {
		const step = completed[index]!;
		if (conflictDetail !== undefined) {
			uncompensated.push(step.label);
			continue;
		}
		const result = await step.undo();
		if (result.status === "reverted") {
			compensated.push(step.label);
			continue;
		}
		conflictDetail = result.detail;
		uncompensated.push(step.label);
		retained.push(...result.retained);
	}

	return {
		compensated,
		uncompensated,
		evidence: {
			failedStep: failure.label,
			detail: conflictDetail ? `${failure.message}; compensation halted: ${conflictDetail}` : failure.message,
			retained: [...new Set(retained)],
		},
	};
}

export interface JsonStepInput {
	readonly label: string;
	readonly step: IntentStep;
	readonly targetPath: string;
	readonly provenancePath: string;
	readonly intentPath: string;
	readonly ownedKeys: readonly string[];
	/** Mutates the parsed target in place. */
	readonly mutate: (draft: Record<string, unknown>) => void;
	/** Produces the ledger that must exist once this step commits. */
	readonly nextLedger: (ledger: ProvenanceLedger) => ProvenanceLedger;
	/** Reverts the target, removing only what this step added. */
	readonly revert: (draft: Record<string, unknown>) => void;
	/** Produces the ledger that must exist once this step is undone. */
	readonly revertLedger: (ledger: ProvenanceLedger) => ProvenanceLedger;
	readonly now: Date;
}

export interface JsonStepOutput {
	readonly completed: CompletedStep;
	readonly changed: boolean;
	readonly backupPath?: string;
}

/**
 * Run one JSON step: intent, target publish, ledger commit, intent clear.
 *
 * The intent is written first and cleared last. Between those points a crash is
 * recoverable because the record alone identifies whether the target carries
 * pre-write bytes, the exact bytes we intended, or something a third party
 * produced.
 */
export async function runJsonStep(input: JsonStepInput): Promise<JsonStepOutput> {
	const current = await readTarget(input.targetPath);
	const plan = planPublish(current, input.mutate);

	const ledgerBefore = await readProvenance(input.provenancePath);
	const ledgerAfter = input.nextLedger(ledgerBefore);
	const provenancePreflightIdentity = await currentIdentity(input.provenancePath);
	const provenanceExpectedIdentity = ledgerIdentity(ledgerAfter);

	if (plan.unchanged && provenancePreflightIdentity === provenanceExpectedIdentity) {
		return { completed: { label: input.label, undo: async () => ({ status: "reverted" }) }, changed: false };
	}

	const intent: IntentRecord = {
		version: INTENT_VERSION,
		step: input.step,
		targetPath: input.targetPath,
		ownedKeys: input.ownedKeys,
		targetPreflightIdentity: current.identity,
		targetExpectedIdentity: plan.expectedIdentity,
		provenancePath: input.provenancePath,
		provenancePreflightIdentity,
		provenanceExpectedIdentity,
		provenancePayload: ledgerAfter,
		startedAt: input.now.toISOString(),
	};
	await writeIntent(input.intentPath, intent);

	let backupPath: string | undefined;
	try {
		const published = await publishPlan(input.targetPath, plan, {
			expectedIdentity: current.identity,
			backup: true,
			now: input.now,
		});
		backupPath = published.backupPath;
		await writeProvenance(input.provenancePath, ledgerAfter);
	} catch (error) {
		throw new SagaStepError(input.label, error instanceof Error ? error.message : String(error), [
			input.intentPath,
			...(backupPath ? [backupPath] : []),
		]);
	}
	await clearIntent(input.intentPath);

	const successIdentity = plan.expectedIdentity;
	return {
		completed: {
			label: input.label,
			undo: async (): Promise<StepUndoResult> => {
				const observed = await currentIdentity(input.targetPath);
				if (observed !== successIdentity) {
					return {
						status: "conflict",
						detail: `${input.targetPath} changed after GJC wrote it; GJC will not overwrite the newer contents`,
						retained: [input.provenancePath, ...(backupPath ? [backupPath] : [])],
					};
				}
				const now = await readTarget(input.targetPath);
				const revertPlan = planPublish(now, input.revert);
				await publishPlan(input.targetPath, revertPlan, {
					expectedIdentity: now.identity,
					backup: false,
					now: input.now,
				});
				await writeProvenance(input.provenancePath, input.revertLedger(await readProvenance(input.provenancePath)));
				return { status: "reverted" };
			},
		},
		changed: true,
		backupPath,
	};
}

/** Hash a ledger exactly as it will be serialized, so the expected identity is computable up front. */
function ledgerIdentity(ledger: ProvenanceLedger): string {
	return hashBytes(`${JSON.stringify(ledger, null, 2)}\n`);
}

/** Wrap a `CasReceipt` as a compensable step. */
export function receiptStep(label: string, receipt: CasReceipt): CompletedStep {
	return {
		label,
		undo: async (): Promise<StepUndoResult> => {
			const restored = await receipt.restore();
			if (restored.status === "restored" || restored.status === "discarded") return { status: "reverted" };
			if (restored.status === "conflict") {
				return {
					status: "conflict",
					detail: `config.yml changed at ${restored.paths.join(", ")} since GJC appended to it`,
					retained: [],
				};
			}
			return { status: "conflict", detail: "the config.yml change is not restorable", retained: [] };
		},
	};
}

export interface RecoverIntentOptions {
	/**
	 * Act on the classification rather than only reporting it.
	 *
	 * Install passes `true`. `--check` passes `false` because it must stay
	 * read-only: it surfaces the lingering intent as drift and leaves the repair
	 * to the next install.
	 */
	readonly repair: boolean;
}

/**
 * Classify a lingering intent left by an interrupted run, and optionally act.
 *
 * The outcome comes from classifying BOTH the target and the ledger:
 *
 * - `discard`   the publish never landed, so nothing was mutated. Safe to clear.
 * - `complete-ledger` the publish landed but the ledger commit did not. Re-running
 *   the same install re-derives and commits the identical provenance in step 1,
 *   so recovery is to PROCEED. The intent is deliberately left in place until
 *   that step overwrites it, because clearing it first would lose recoverability
 *   if the retry is interrupted too.
 * - `refuse`    a third party changed one of the files. Never replay a recorded
 *   write over someone else's change.
 */
export async function recoverIntent(
	intentPath: string,
	options: RecoverIntentOptions = { repair: false },
): Promise<{ recovered: boolean; detail: string } | undefined> {
	const intent = await readIntent(intentPath);
	if (!intent) return undefined;
	const recovery = await classifyIntent(intent);
	if (recovery.action === "refuse") return { recovered: false, detail: recovery.detail };
	if (!options.repair) return { recovered: false, detail: recovery.detail };
	if (recovery.action === "discard") {
		await clearIntent(intentPath);
		return { recovered: true, detail: recovery.detail };
	}

	// complete-ledger: the publish landed, the ledger commit did not. Finish it
	// from the intent's own payload rather than relying on a retry to re-run the
	// step -- a seed-if-empty step would be skipped on retry, because its own
	// publish already filled the roles it was gated on.
	const pending = pendingLedgerOf(intent);
	if (!pending) {
		return {
			recovered: false,
			detail: `${recovery.detail}, but the interrupted step recorded no ledger payload to finish`,
		};
	}
	await writeProvenance(intent.provenancePath, pending);
	await clearIntent(intentPath);
	return { recovered: true, detail: `${recovery.detail}; provenance recorded` };
}
