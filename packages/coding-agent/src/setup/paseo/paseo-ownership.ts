/**
 * GJC-side ownership provenance and crash-recovery intent.
 *
 * Both records live under the GJC agent directory, never inside the user's
 * Paseo files. Two separate concerns share this module because both answer the
 * same question -- "did GJC actually do this?" -- and both are consumed by the
 * install saga and by `--remove`.
 *
 * Provenance exists because "the current value equals what we would write" is
 * NOT evidence that we wrote it: a user who hand-authored the same value would
 * otherwise have it silently deleted by `--remove`.
 *
 * The intent record exists because a target file and the provenance ledger are
 * separate files and cannot be renamed atomically together. It is written
 * BEFORE either mutation and carries enough identity to classify the target on
 * its own after a crash, without needing any later update.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ABSENT_IDENTITY, currentIdentity, serializeJson } from "./json-publisher";

export const PROVENANCE_VERSION = 1;
export const INTENT_VERSION = 1;

export interface ProvenanceLedger {
	readonly version: number;
	/** `agents.providers` keys GJC created, mapped to the value hash it wrote. */
	readonly providerKeys: Record<string, string>;
	/** Orchestration role keys GJC actually seeded, mapped to the value it wrote. */
	readonly seededOrchestrationKeys: Record<string, string>;
	/** Bridge directory path GJC created, when it created it. */
	readonly bridgePath?: string;
	/** Bridge entries GJC created, so the inverse removes exactly those. */
	readonly bridgeEntries?: readonly string[];
	/** True when GJC created the bridge directory itself (as opposed to populating an existing one). */
	readonly bridgeDirCreated?: boolean;
}

export const EMPTY_LEDGER: ProvenanceLedger = {
	version: PROVENANCE_VERSION,
	providerKeys: {},
	seededOrchestrationKeys: {},
};

export async function readProvenance(provenancePath: string): Promise<ProvenanceLedger> {
	let raw: string;
	try {
		raw = await Bun.file(provenancePath).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_LEDGER;
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ProvenanceLedger>;
		return {
			version: typeof parsed.version === "number" ? parsed.version : PROVENANCE_VERSION,
			providerKeys: isStringRecord(parsed.providerKeys) ? parsed.providerKeys : {},
			seededOrchestrationKeys: isStringRecord(parsed.seededOrchestrationKeys) ? parsed.seededOrchestrationKeys : {},
			...(typeof parsed.bridgePath === "string" ? { bridgePath: parsed.bridgePath } : {}),
			...(Array.isArray(parsed.bridgeEntries)
				? { bridgeEntries: parsed.bridgeEntries.filter((entry): entry is string => typeof entry === "string") }
				: {}),
			...(typeof parsed.bridgeDirCreated === "boolean" ? { bridgeDirCreated: parsed.bridgeDirCreated } : {}),
		};
	} catch {
		// A corrupt GJC-side ledger must not brick removal: treat it as empty so
		// nothing is deleted on unproven ownership, which is the safe direction.
		return EMPTY_LEDGER;
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function writeProvenance(provenancePath: string, ledger: ProvenanceLedger): Promise<void> {
	await fs.mkdir(path.dirname(provenancePath), { recursive: true, mode: 0o700 });
	await Bun.write(provenancePath, serializeJson(ledger));
	await fs.chmod(provenancePath, 0o600);
}

/**
 * True only when GJC recorded this provider key AND the value still hashes to
 * what GJC wrote. A user edit after install makes this false, which is what
 * keeps `--remove` from destroying their change.
 */
export function isProvenancedProvider(ledger: ProvenanceLedger, key: string, currentValueHash: string): boolean {
	const recorded = ledger.providerKeys[key];
	return recorded !== undefined && recorded === currentValueHash;
}

export function isProvenancedOrchestrationKey(ledger: ProvenanceLedger, key: string, currentValue: string): boolean {
	const recorded = ledger.seededOrchestrationKeys[key];
	return recorded !== undefined && recorded === currentValue;
}

/** Every `gjc`/`gjc-<preset>` key GJC recorded, so a plain `--remove` cleans up earlier `--mpreset` runs. */
export function provenancedProviderKeys(ledger: ProvenanceLedger): readonly string[] {
	return Object.keys(ledger.providerKeys).sort();
}

export type IntentStep = "provider-config" | "orchestration-preferences";

/**
 * Durable, credential-free intent record.
 *
 * Written before either the target publish or the ledger commit, and carrying
 * BOTH identities for BOTH files, so recovery can classify each file as
 * before / intended-after / divergent from this record alone. It stores only
 * paths, key names, and hashes -- never file contents, diffs, or values -- so
 * it stays credential-free even though `config.json` holds a bcrypt password.
 */
export interface IntentRecord {
	readonly version: number;
	readonly step: IntentStep;
	readonly targetPath: string;
	readonly ownedKeys: readonly string[];
	readonly targetPreflightIdentity: string;
	readonly targetExpectedIdentity: string;
	readonly provenancePath: string;
	readonly provenancePreflightIdentity: string;
	readonly provenanceExpectedIdentity: string;
	/**
	 * The exact ledger this step intended to commit.
	 *
	 * Carried so recovery can finish the commit without re-running the step. That
	 * matters for seed-if-empty work: once the target publish has landed the roles
	 * are no longer empty, so a retry would skip the step and the ledger would
	 * never be written. Contains only key names and hashes, never values from the
	 * user's files, so the record stays credential-free.
	 */
	readonly provenancePayload?: ProvenanceLedger;
	readonly startedAt: string;
}

export async function writeIntent(intentPath: string, intent: IntentRecord): Promise<void> {
	await fs.mkdir(path.dirname(intentPath), { recursive: true, mode: 0o700 });
	await Bun.write(intentPath, serializeJson(intent));
	await fs.chmod(intentPath, 0o600);
}

export async function readIntent(intentPath: string): Promise<IntentRecord | undefined> {
	let raw: string;
	try {
		raw = await Bun.file(intentPath).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as IntentRecord;
		if (typeof parsed?.targetPath !== "string" || typeof parsed?.targetExpectedIdentity !== "string")
			return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export async function clearIntent(intentPath: string): Promise<void> {
	await fs.rm(intentPath, { force: true }).catch(() => undefined);
}

/** Rebuild the ledger an interrupted step intended to commit, when it recorded one. */
export function pendingLedgerOf(intent: IntentRecord): ProvenanceLedger | undefined {
	return intent.provenancePayload;
}

/** Where a file sits relative to an interrupted step. */
export type IntentFileState = "before" | "intended-after" | "divergent";

export function classifyIdentity(observed: string, preflight: string, expected: string): IntentFileState {
	if (observed === expected) return "intended-after";
	if (observed === preflight) return "before";
	return "divergent";
}

export type IntentRecovery =
	| { readonly action: "discard"; readonly detail: string }
	| { readonly action: "complete-ledger"; readonly detail: string }
	| { readonly action: "refuse"; readonly detail: string };

/**
 * Classify BOTH the target and the ledger before deciding what to do.
 *
 * Deliberately exhaustive over the nine combinations: a divergent ledger always
 * refuses, because replaying a recorded ledger output over a third party's
 * change would destroy it.
 */
export async function classifyIntent(intent: IntentRecord): Promise<IntentRecovery> {
	const [targetObserved, ledgerObserved] = await Promise.all([
		currentIdentity(intent.targetPath),
		currentIdentity(intent.provenancePath),
	]);
	const target = classifyIdentity(targetObserved, intent.targetPreflightIdentity, intent.targetExpectedIdentity);
	const ledger = classifyIdentity(
		ledgerObserved,
		intent.provenancePreflightIdentity,
		intent.provenanceExpectedIdentity,
	);

	if (ledger === "divergent") {
		return {
			action: "refuse",
			detail: `the provenance ledger at ${intent.provenancePath} changed unexpectedly; GJC will not overwrite it`,
		};
	}
	if (target === "divergent") {
		return {
			action: "refuse",
			detail: `${intent.targetPath} was changed by another writer during an interrupted GJC step; GJC will not touch it`,
		};
	}
	if (target === "intended-after" && ledger === "before") {
		return { action: "complete-ledger", detail: `${intent.targetPath} was published; recording its provenance` };
	}
	if (target === "intended-after" && ledger === "intended-after") {
		return { action: "discard", detail: "both writes landed; clearing the stale intent" };
	}
	// target === "before": the publish never landed, so nothing was mutated.
	return { action: "discard", detail: `${intent.targetPath} was never modified; discarding the stale intent` };
}

export { ABSENT_IDENTITY };
