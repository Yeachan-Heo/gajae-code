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
import { ABSENT_IDENTITY, currentIdentity, hashBytes, serializeJson } from "./json-publisher";

export const PROVENANCE_VERSION = 1;
export const INTENT_VERSION = 1;

/** Pointer to the private sidecar holding a `--force`-replaced provider entry. */
export interface ProviderReplacedRef {
	/** Absolute path of the mode-0600 sidecar beside Paseo's own config file. */
	readonly backupPath: string;
	/** Digest of the preserved value, binding the sidecar's bytes to this record. */
	readonly valueSha256: string;
}

/**
 * Durable no-follow identity for one GJC-created Paseo bridge symlink.
 * Strings preserve platform-sized inode fields in JSON without precision loss.
 */
export interface BridgeEntryIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly size: string;
	readonly mtimeNs: string;
}

export interface ProvenanceLedger {
	readonly version: number;
	/** `agents.providers` keys GJC created, mapped to the value hash it wrote. */
	readonly providerKeys: Record<string, string>;
	/**
	 * `agents.providers` keys that already existed when GJC ran and whose value
	 * equaled GJC's desired entry. GJC wrote nothing at those keys, so it never
	 * owns them; the marker keeps a convergence re-run from adopting them.
	 * Optional because ledgers written before this field existed never carry it.
	 */
	readonly providerPreexistingKeys?: Record<string, true>;
	/**
	 * For `--force` overwrites, a pointer to the private mode-0600 sidecar that
	 * preserves the exact provider entry GJC replaced. `--remove` restores from
	 * that sidecar instead of deleting the key, because the replaced content was
	 * never GJC's to take. The value itself lives only in the sidecar beside
	 * Paseo's own config -- never in this ledger or the intent record -- because
	 * a provider entry can carry credential-bearing `env` or argument values and
	 * GJC-side state is credential-free by contract. Optional for the same
	 * legacy-ledger reason.
	 */
	readonly providerReplacedEntries?: Record<string, ProviderReplacedRef>;
	/** Orchestration role keys GJC actually seeded, mapped to the value it wrote. */
	readonly seededOrchestrationKeys: Record<string, string>;
	/** Bridge directory path GJC created, when it created it. */
	readonly bridgePath?: string;
	/** Source directory the bridge entries were linked from, so `--remove` can verify targets. */
	readonly bridgeSourceDir?: string;
	/** Bridge entries GJC created, so the inverse removes exactly those. */
	readonly bridgeEntries?: readonly string[];
	/** Install-time identities for bridge entries GJC may later remove. */
	readonly bridgeEntryIdentities?: Record<string, BridgeEntryIdentity>;
	/** True when GJC created the bridge directory itself (as opposed to populating an existing one). */
	readonly bridgeDirCreated?: boolean;
	/** No-follow identity of the bridge directory GJC created. */
	readonly bridgeDirIdentity?: BridgeEntryIdentity;
}

export const EMPTY_LEDGER: ProvenanceLedger = {
	version: PROVENANCE_VERSION,
	providerKeys: {},
	providerPreexistingKeys: {},
	providerReplacedEntries: {},
	seededOrchestrationKeys: {},
};

const PROVENANCE_PAYLOAD_FIELDS = new Set([
	"version",
	"providerKeys",
	"providerPreexistingKeys",
	"providerReplacedEntries",
	"seededOrchestrationKeys",
	"bridgePath",
	"bridgeSourceDir",
	"bridgeEntries",
	"bridgeEntryIdentities",
	"bridgeDirCreated",
	"bridgeDirIdentity",
]);

export class ProvenanceLedgerCorruptError extends Error {
	constructor(provenancePath: string, detail: string) {
		super(
			`Paseo provenance ledger is corrupt (${provenancePath}): ${detail}. Restore it from a backup or delete it after confirming no Paseo bridge links are live; GJC will not guess ownership from a damaged record.`,
		);
		this.name = "ProvenanceLedgerCorruptError";
	}
}

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
		// Every field that is PRESENT but malformed is corruption, not a
		// default: silently replacing it with an empty value would let removal
		// act on a partially tampered record (a dropped replaced-provider
		// pointer deletes the user's key without restoring it; a filtered
		// bridgeEntries list abandons links the record still owns). Absent
		// fields stay defaulted so older ledger shapes keep reading.
		const strictStringRecord = (value: unknown, field: string): Record<string, string> => {
			if (value === undefined) return {};
			if (!isStringRecord(value)) throw new Error(`${field} is present but not a string record`);
			return value;
		};
		if (parsed.version !== undefined && typeof parsed.version !== "number") {
			throw new Error("version is present but not a number");
		}
		if (parsed.providerPreexistingKeys !== undefined && !isTrueRecord(parsed.providerPreexistingKeys)) {
			throw new Error("providerPreexistingKeys is present but not a boolean record");
		}
		if (
			parsed.providerReplacedEntries !== undefined &&
			!isProviderReplacedRefRecord(parsed.providerReplacedEntries)
		) {
			throw new Error("providerReplacedEntries is present but not a replaced-ref record");
		}
		if (parsed.bridgePath !== undefined && typeof parsed.bridgePath !== "string") {
			throw new Error("bridgePath is present but not a string");
		}
		if (parsed.bridgeSourceDir !== undefined && typeof parsed.bridgeSourceDir !== "string") {
			throw new Error("bridgeSourceDir is present but not a string");
		}
		if (parsed.bridgeDirCreated !== undefined && typeof parsed.bridgeDirCreated !== "boolean") {
			throw new Error("bridgeDirCreated is present but not a boolean");
		}
		if (parsed.bridgeDirIdentity !== undefined && !isBridgeEntryIdentity(parsed.bridgeDirIdentity)) {
			throw new Error("bridgeDirIdentity is present but not an identity");
		}
		if (parsed.bridgeEntries !== undefined) {
			if (!Array.isArray(parsed.bridgeEntries)) throw new Error("bridgeEntries is present but not an array");
			if (!parsed.bridgeEntries.every(entry => typeof entry === "string")) {
				throw new Error("bridgeEntries contains a non-string entry");
			}
		}
		if (parsed.bridgeEntryIdentities !== undefined && !isBridgeEntryIdentityRecord(parsed.bridgeEntryIdentities)) {
			throw new Error("bridgeEntryIdentities is present but not an identity record");
		}
		return {
			version: typeof parsed.version === "number" ? parsed.version : PROVENANCE_VERSION,
			providerKeys: strictStringRecord(parsed.providerKeys, "providerKeys"),
			providerPreexistingKeys: isTrueRecord(parsed.providerPreexistingKeys) ? parsed.providerPreexistingKeys : {},
			providerReplacedEntries: isProviderReplacedRefRecord(parsed.providerReplacedEntries)
				? parsed.providerReplacedEntries
				: {},
			seededOrchestrationKeys: strictStringRecord(parsed.seededOrchestrationKeys, "seededOrchestrationKeys"),
			...(typeof parsed.bridgePath === "string" ? { bridgePath: parsed.bridgePath } : {}),
			...(typeof parsed.bridgeSourceDir === "string" ? { bridgeSourceDir: parsed.bridgeSourceDir } : {}),
			...(Array.isArray(parsed.bridgeEntries) ? { bridgeEntries: parsed.bridgeEntries } : {}),
			...(isBridgeEntryIdentityRecord(parsed.bridgeEntryIdentities)
				? { bridgeEntryIdentities: parsed.bridgeEntryIdentities }
				: {}),
			...(typeof parsed.bridgeDirCreated === "boolean" ? { bridgeDirCreated: parsed.bridgeDirCreated } : {}),
			...(isBridgeEntryIdentity(parsed.bridgeDirIdentity) ? { bridgeDirIdentity: parsed.bridgeDirIdentity } : {}),
		};
	} catch (error) {
		// A corrupt GJC-side ledger is an explicit recovery error, not an empty
		// ledger: treating it as empty would silently discard every ownership
		// record while the links those records cover are still live, defeating
		// the record-before-mutation guarantee.
		throw new ProvenanceLedgerCorruptError(provenancePath, error instanceof Error ? error.message : String(error));
	}
}

function isProviderReplacedRefRecord(value: unknown): value is Record<string, ProviderReplacedRef> {
	if (!isRecord(value)) return false;
	for (const ref of Object.values(value)) {
		if (
			!isRecord(ref) ||
			typeof ref.backupPath !== "string" ||
			!path.isAbsolute(ref.backupPath) ||
			typeof ref.valueSha256 !== "string"
		) {
			return false;
		}
	}
	return true;
}

function isBridgeEntryIdentityRecord(value: unknown): value is Record<string, BridgeEntryIdentity> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(isBridgeEntryIdentity);
}
function isBridgeEntryIdentity(value: unknown): value is BridgeEntryIdentity {
	return (
		isRecord(value) &&
		typeof value.dev === "string" &&
		typeof value.ino === "string" &&
		typeof value.size === "string" &&
		typeof value.mtimeNs === "string" &&
		/^\d+$/u.test(value.dev) &&
		/^\d+$/u.test(value.ino) &&
		/^\d+$/u.test(value.size) &&
		/^-?\d+$/u.test(value.mtimeNs)
	);
}
function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// Every VALUE must be a string too (#4644 review r10): `{gjc: 7}` is a
	// malformed record, not a valid string record, and accepting it would let
	// a tampered ledger carry non-string provenance through fail-closed checks.
	return Object.values(value).every(entry => typeof entry === "string");
}
function isTrueRecord(value: unknown): value is Record<string, true> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every(entry => entry === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function writeProvenance(provenancePath: string, ledger: ProvenanceLedger): Promise<void> {
	await fs.mkdir(path.dirname(provenancePath), { recursive: true, mode: 0o700 });
	// Write-then-rename: an interrupted Bun.write can leave a truncated file,
	// which would otherwise read back as a corrupt (now explicit-error) ledger
	// and strand every published link without ownership metadata. The temporary
	// is fsynced before the rename so the record is durable once visible.
	const temporary = `${provenancePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	const payload = serializeJson(ledger);
	try {
		const handle = await fs.open(temporary, "w", 0o600);
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, provenancePath);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
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
 * Credential-free cleanup proof for a sidecar created by an interrupted step.
 *
 * The digest covers the complete sidecar bytes, not the value nested inside
 * the provider-backup envelope. Recovery therefore needs no provider key and
 * cannot infer an unrelated cleanup target from the provenance ledger.
 */
export interface IntentDiscardSidecar {
	readonly backupPath: string;
	readonly valueSha256: string;
}

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
	/** Authenticated sidecar to remove only when this intent is discarded before publication. */
	readonly discardSidecar?: IntentDiscardSidecar;
	readonly startedAt: string;
}

function isIntentDiscardSidecar(value: unknown): value is IntentDiscardSidecar {
	return (
		isRecord(value) &&
		typeof value.backupPath === "string" &&
		path.isAbsolute(value.backupPath) &&
		typeof value.valueSha256 === "string" &&
		/^[a-f0-9]{64}$/u.test(value.valueSha256)
	);
}

export async function writeIntent(intentPath: string, intent: IntentRecord): Promise<void> {
	if (intent.discardSidecar !== undefined && !isIntentDiscardSidecar(intent.discardSidecar)) {
		throw new IntentRecordCorruptError(intentPath, "discardSidecar is not an authenticated sidecar reference");
	}
	validateIntentPayload(intentPath, intent);
	await fs.mkdir(path.dirname(intentPath), { recursive: true, mode: 0o700 });
	// Write-then-rename with fsync (#4644 review r10), exactly like the
	// provenance ledger: a truncated intent would read back as absent and
	// recovery would proceed without the record that reconciles a published
	// target with its ledger.
	const temporary = `${intentPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	const payload = serializeJson(intent);
	try {
		const handle = await fs.open(temporary, "w", 0o600);
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, intentPath);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** A present-but-malformed intent record: recovery must refuse, not proceed as if absent. */
export class IntentRecordCorruptError extends Error {
	constructor(intentPath: string, detail: string) {
		super(
			`Paseo intent record is corrupt (${intentPath}): ${detail}. Delete it only after confirming no Paseo setup step was interrupted; GJC will not guess recovery from a damaged record.`,
		);
		this.name = "IntentRecordCorruptError";
	}
}

/** Hash the exact canonical bytes that {@link writeProvenance} publishes. */
export function provenanceLedgerIdentity(ledger: ProvenanceLedger): string {
	return hashBytes(serializeJson(ledger));
}

/**
 * Validate a ledger embedded in an intent record without applying legacy
 * defaults. The payload is the exact object recovery will publish, so accepting
 * a partial or unknown-shaped object here would make the digest bind different
 * bytes from the ledger writer.
 */
export function validateProvenanceLedger(value: unknown): ProvenanceLedger {
	if (!isRecord(value)) throw new Error("provenancePayload is not an object");
	for (const key of Object.keys(value)) {
		if (!PROVENANCE_PAYLOAD_FIELDS.has(key)) throw new Error(`provenancePayload has an unknown field: ${key}`);
	}
	if (value.version !== PROVENANCE_VERSION) {
		throw new Error(`provenancePayload.version is not ${PROVENANCE_VERSION}`);
	}
	if (!Object.prototype.hasOwnProperty.call(value, "providerKeys") || !isStringRecord(value.providerKeys)) {
		throw new Error("provenancePayload.providerKeys is not a string record");
	}
	if (
		!Object.prototype.hasOwnProperty.call(value, "seededOrchestrationKeys") ||
		!isStringRecord(value.seededOrchestrationKeys)
	) {
		throw new Error("provenancePayload.seededOrchestrationKeys is not a string record");
	}
	if (value.providerPreexistingKeys !== undefined && !isTrueRecord(value.providerPreexistingKeys)) {
		throw new Error("provenancePayload.providerPreexistingKeys is not a boolean record");
	}
	if (value.providerReplacedEntries !== undefined && !isProviderReplacedRefRecord(value.providerReplacedEntries)) {
		throw new Error("provenancePayload.providerReplacedEntries is not a replaced-ref record");
	}
	if (value.bridgePath !== undefined && typeof value.bridgePath !== "string") {
		throw new Error("provenancePayload.bridgePath is not a string");
	}
	if (value.bridgeSourceDir !== undefined && typeof value.bridgeSourceDir !== "string") {
		throw new Error("provenancePayload.bridgeSourceDir is not a string");
	}
	if (value.bridgeDirCreated !== undefined && typeof value.bridgeDirCreated !== "boolean") {
		throw new Error("provenancePayload.bridgeDirCreated is not a boolean");
	}
	if (value.bridgeDirIdentity !== undefined && !isBridgeEntryIdentity(value.bridgeDirIdentity)) {
		throw new Error("provenancePayload.bridgeDirIdentity is not an identity");
	}
	if (value.bridgeEntries !== undefined) {
		if (!Array.isArray(value.bridgeEntries)) throw new Error("provenancePayload.bridgeEntries is not an array");
		if (!value.bridgeEntries.every(entry => typeof entry === "string")) {
			throw new Error("provenancePayload.bridgeEntries contains a non-string entry");
		}
	}
	if (value.bridgeEntryIdentities !== undefined && !isBridgeEntryIdentityRecord(value.bridgeEntryIdentities)) {
		throw new Error("provenancePayload.bridgeEntryIdentities is not an identity record");
	}
	return value as unknown as ProvenanceLedger;
}

function validateIntentPayload(intentPath: string, intent: IntentRecord): void {
	if (intent.provenancePayload === undefined) return;
	try {
		const payload = validateProvenanceLedger(intent.provenancePayload);
		if (provenanceLedgerIdentity(payload) !== intent.provenanceExpectedIdentity) {
			throw new Error("provenancePayload canonical digest does not match provenanceExpectedIdentity");
		}
	} catch (error) {
		if (error instanceof IntentRecordCorruptError) throw error;
		throw new IntentRecordCorruptError(intentPath, error instanceof Error ? error.message : String(error));
	}
}

export async function readIntent(intentPath: string): Promise<IntentRecord | undefined> {
	let raw: string;
	try {
		raw = await Bun.file(intentPath).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	// A record that is PRESENT but unparseable or wrong-shaped is corruption,
	// not absence (#4644 review r10): treating it as absent would let recovery
	// run without the evidence that reconciles a published target with its
	// ledger. Callers surface this as a refusal.
	try {
		const parsed = JSON.parse(raw) as IntentRecord;
		// EVERY field the recovery path trusts is validated here (#4644 review
		// r13): a tampered record that kept only the two target fields could
		// otherwise steer recovery at an arbitrary provenance path or replay a
		// crafted ledger payload.
		const stringField = (value: unknown, name: string): string => {
			if (typeof value !== "string" || value.length === 0) {
				throw new IntentRecordCorruptError(intentPath, `${name} is missing or not a string`);
			}
			return value;
		};
		stringField(parsed?.targetPath, "targetPath");
		stringField(parsed?.targetExpectedIdentity, "targetExpectedIdentity");
		stringField(parsed?.targetPreflightIdentity, "targetPreflightIdentity");
		stringField(parsed?.provenancePath, "provenancePath");
		stringField(parsed?.provenancePreflightIdentity, "provenancePreflightIdentity");
		stringField(parsed?.provenanceExpectedIdentity, "provenanceExpectedIdentity");
		stringField(parsed?.startedAt, "startedAt");
		if (parsed?.step !== "provider-config" && parsed?.step !== "orchestration-preferences") {
			throw new IntentRecordCorruptError(intentPath, "step is not a known intent step");
		}
		if (typeof parsed?.version !== "number") {
			throw new IntentRecordCorruptError(intentPath, "version is not a number");
		}
		if (
			!Array.isArray(parsed?.ownedKeys) ||
			!parsed.ownedKeys.every(key => typeof key === "string" && key.length > 0)
		) {
			throw new IntentRecordCorruptError(intentPath, "ownedKeys is not a non-empty string array");
		}
		// The provenance path the record names must sit in the SAME agent
		// directory tree as the intent record itself: recovery writes through
		// it, so a tampered record must not redirect that write elsewhere.
		// The check is CANONICAL (#4644 review r19): lexical path.relative can
		// be satisfied through a symlinked ancestor that resolves outside the
		// agent directory, so both trees are realpath-resolved first and a
		// symlinked ancestry that redirects the record's tree out of the
		// intent's tree is refused.
		const intentDir = path.dirname(await fs.realpath(path.resolve(intentPath)).catch(() => path.resolve(intentPath)));
		const namedProvenance = path.resolve(parsed.provenancePath);
		const namedDir = await fs.realpath(path.dirname(namedProvenance)).catch(() => path.dirname(namedProvenance));
		const rel = path.relative(intentDir, namedDir);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new IntentRecordCorruptError(
				intentPath,
				`the recorded provenance path (${parsed.provenancePath}) escapes the agent directory that holds the intent record`,
			);
		}
		if (parsed?.provenancePayload !== undefined) {
			validateIntentPayload(intentPath, parsed);
		}
		if (parsed?.discardSidecar !== undefined && !isIntentDiscardSidecar(parsed.discardSidecar)) {
			throw new IntentRecordCorruptError(intentPath, "discardSidecar is not an authenticated sidecar reference");
		}
		return parsed;
	} catch (error) {
		if (error instanceof IntentRecordCorruptError) throw error;
		throw new IntentRecordCorruptError(intentPath, error instanceof Error ? error.message : String(error));
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
