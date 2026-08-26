/**
 * Top-level orchestration for `gjc setup paseo`.
 *
 * Dispatches to diagnosis, install, or removal, and owns the flag combinations
 * that must be rejected before any target is touched.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	exactRemoveDirectoryTree,
	type NativeDirectoryTreeResult,
	renameNoReplacePath,
	snapshotDirectoryTree,
	symlinkNoReplacePath,
} from "@gajae-code/natives";
import { Settings } from "../../config/settings";
import { checkPaseoSetup } from "./check";
import { type CompletedStep, compensate, receiptStep, recoverIntent, runJsonStep, SagaStepError } from "./install-saga";
import {
	currentIdentity,
	hashBytes,
	hasNoReparseSidecarAuthority,
	PaseoPublishError,
	type PersistedFileIdentity,
	readReplacedProviderBackup,
	readTarget,
	removeReplacedProviderBackup,
	replacedProviderBackupPath,
	serializeJson,
	writeReplacedProviderBackup,
} from "./json-publisher";
import { createOrchestrationSeed, removeSeededRoles } from "./orchestration-preferences";
import { withPaseoMutationLock } from "./paseo-mutation-lock";
import {
	type BridgeCleanupAuthority,
	type BridgeEntryIdentity,
	clearIntent,
	INTENT_VERSION,
	type IntentRecord,
	type ProvenanceLedger,
	ProvenancePublicationUncertainError,
	provenanceLedgerIdentity,
	readIntent,
	readProvenance,
	writeIntent,
	writeProvenance,
} from "./paseo-ownership";
import {
	buildProviderEntry,
	createProviderMutation,
	hasProviderConflict,
	providerEntryHash,
	providerKeyFor,
	resolveGjcCommand,
} from "./provider-config";
import { removePaseoSetup, safeBridgeEntryNames, validatedBridgeDir } from "./remove";
import type { PaseoInstallResult, PaseoRemoveResult, SetupCheckResult } from "./result-types";
import {
	isTrustedRecordedSkillsSource,
	type PaseoSetupDependencies,
	type PaseoSkillSource,
	resolvePaseoSkillsSource,
} from "./setup-deps";
import type { SkillsBridgeAmbiguity, SkillsBridgeInstallResult } from "./skills-bridge";
import {
	canonicalExistingPathForNative,
	installSkillsBridge,
	inverseSkillsBridge,
	legacySourceDirFor,
	preflightSkillsBridge,
	registerSkillsBridgeDirectory,
	replayBridgeCleanup,
	SkillsBridgeError,
	SkillsBridgePartialError,
} from "./skills-bridge";

export interface PaseoSetupFlags {
	readonly check?: boolean;
	readonly json?: boolean;
	readonly force?: boolean;
	readonly remove?: boolean;
	readonly mpreset?: string;
}

export class PaseoSetupUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaseoSetupUsageError";
	}
}

/** Durable owner/direction for a pending bridge-root cleanup. */
type BridgeCleanupDirection = "rollback" | "forward";
type BridgeCleanupOwner = "destination" | "migration-old-root";
type BridgeCleanupMetadata = {
	readonly cleanupDirection: BridgeCleanupDirection;
	readonly cleanupOwner: BridgeCleanupOwner;
};
type DurableBridgeCleanupAuthority = BridgeCleanupAuthority & Partial<BridgeCleanupMetadata>;

const DESTINATION_ROLLBACK_CLEANUP: BridgeCleanupMetadata = {
	cleanupDirection: "rollback",
	cleanupOwner: "destination",
};
const MIGRATION_FORWARD_CLEANUP: BridgeCleanupMetadata = {
	cleanupDirection: "forward",
	cleanupOwner: "migration-old-root",
};

export type PaseoSetupOutcome =
	| { readonly kind: "check"; readonly result: SetupCheckResult }
	| { readonly kind: "install"; readonly result: PaseoInstallResult }
	| { readonly kind: "remove"; readonly result: PaseoRemoveResult };

async function persistBridgeCleanupPending(
	deps: PaseoSetupDependencies,
	authority: BridgeCleanupAuthority,
	metadata?: BridgeCleanupMetadata,
): Promise<void> {
	const current = await readProvenance(deps.paths.provenanceLedger);
	const persistedAuthority: DurableBridgeCleanupAuthority =
		metadata === undefined ? (authority as DurableBridgeCleanupAuthority) : { ...authority, ...metadata };
	const pending = { ...current, bridgeCleanupPending: persistedAuthority };
	// Keep the migration intent's pre-cutover and post-cutover payloads
	// independent. `pending` is cleanup authority for the OLD bridge root; it is
	// not the desired destination provenance. Replacing `intent.provenancePayload`
	// here would strand the destination state after a crash between namespace
	// detach and the final ledger commit.
	await writeProvenance(deps.paths.provenanceLedger, pending);
}

function cleanupMetadataOf(authority: BridgeCleanupAuthority): BridgeCleanupMetadata | undefined {
	const candidate = authority as DurableBridgeCleanupAuthority;
	if (candidate.cleanupDirection === undefined && candidate.cleanupOwner === undefined) return undefined;
	if (
		(candidate.cleanupDirection !== "rollback" && candidate.cleanupDirection !== "forward") ||
		(candidate.cleanupOwner !== "destination" && candidate.cleanupOwner !== "migration-old-root") ||
		(candidate.cleanupDirection === "rollback" && candidate.cleanupOwner !== "destination") ||
		(candidate.cleanupDirection === "forward" && candidate.cleanupOwner !== "migration-old-root")
	)
		return undefined;
	return {
		cleanupDirection: candidate.cleanupDirection,
		cleanupOwner: candidate.cleanupOwner,
	};
}

async function canonicalPathForComparison(value: string): Promise<string> {
	const absolute = path.resolve(value);
	try {
		return await fs.realpath(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = await fs.realpath(path.dirname(absolute)).catch(() => path.dirname(absolute));
		return path.join(parent, path.basename(absolute));
	}
}

async function trustedBridgePathsForRecovery(deps: PaseoSetupDependencies): Promise<readonly string[]> {
	const paths = [deps.paths.bridgeDir];
	const ledger = await readProvenance(deps.paths.provenanceLedger);
	if (ledger.bridgePath !== undefined) {
		try {
			paths.push(await validatedBridgeDir(ledger, deps));
		} catch {
			// The active recovery path will report malformed ownership; do not add
			// an unauthenticated ledger path to the replay allow-list.
		}
	}
	// A post-detach migration intentionally leaves the original root absent;
	// `validatedBridgeDir` cannot authenticate that missing pathname. The
	// pending authority is nevertheless durable proof of the exact old root and
	// its deterministic `.removing` sibling. Admit that original path only when
	// it agrees with the ledger's recorded bridge (or the active configured
	// bridge), so a tampered pending record cannot broaden the replay surface.
	const pending = ledger.bridgeCleanupPending;
	const pendingCanonicalPath =
		pending === undefined ? undefined : await canonicalPathForComparison(pending.originalPath);
	const recordedCanonicalPath =
		ledger.bridgePath === undefined ? undefined : await canonicalPathForComparison(ledger.bridgePath);
	const configuredCanonicalPath = await canonicalPathForComparison(deps.paths.bridgeDir);
	if (
		pending !== undefined &&
		pendingCanonicalPath !== undefined &&
		((recordedCanonicalPath !== undefined && pendingCanonicalPath === recordedCanonicalPath) ||
			(recordedCanonicalPath === undefined && pendingCanonicalPath === configuredCanonicalPath))
	) {
		paths.push(pending.originalPath);
	}
	return [...new Set(await Promise.all(paths.map(value => canonicalPathForComparison(value))))];
}

/**
 * Replay a pending bridge cleanup from either side of the native detach.
 *
 * `replayBridgeCleanup` handles the normal post-detach case, where only the
 * inert `.removing` sibling remains. A crash can also land after old links are
 * removed but before the native no-replace detach, leaving the original empty
 * root live. In that pre-detach window we invoke the same identity-bound
 * inverse with an empty result so it can perform the detach safely; the
 * pending authority is persisted again before that native mutation.
 */
async function replayPendingBridgeCleanup(
	deps: PaseoSetupDependencies,
	authority: BridgeCleanupAuthority,
): Promise<void> {
	const [original, detached] = await Promise.all([
		fs.lstat(authority.originalPath).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}),
		fs.lstat(authority.detachedPath).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}),
	]);
	if (original !== undefined && detached !== undefined) {
		throw new SkillsBridgeError(
			`Paseo skills bridge cleanup authority has both original and detached roots live: ${authority.originalPath}`,
		);
	}
	if (original === undefined) {
		await replayBridgeCleanup(authority);
		return;
	}
	if (!original.isDirectory() || original.isSymbolicLink()) {
		throw new SkillsBridgeError(
			`Paseo skills bridge pre-detach authority is not an empty directory: ${authority.originalPath}`,
		);
	}
	const root = authority.snapshot.entries.find(entry => entry.relativePath === "");
	if (root === undefined || root.kind !== "directory") {
		throw new SkillsBridgeError(
			`Paseo skills bridge pre-detach authority has no root identity: ${authority.originalPath}`,
		);
	}
	const ledger = await readProvenance(deps.paths.provenanceLedger);
	const metadata = cleanupMetadataOf(authority);
	await inverseSkillsBridge(
		deps,
		{
			createdEntries: [],
			prunedEntries: [],
			adoptedEntries: [],
			entryIdentities: {},
			bridgeDirCreated: true,
			bridgeDirIdentity: {
				dev: root.dev,
				ino: root.ino,
				size: root.size,
				mtimeNs: root.mtimeNs,
			},
			sourceDir: ledger.bridgeSourceDir ?? legacySourceDirFor(deps),
		},
		{
			bridgeDir: authority.originalPath,
			onCleanupPending: pending => persistBridgeCleanupPending(deps, pending, metadata),
		},
	);
}

/**
 * Reject flag combinations that have no coherent meaning.
 *
 * Rejected before any read or write so a misuse can never leave partial state.
 */
export function assertUsableFlags(flags: PaseoSetupFlags): void {
	if (flags.check && flags.remove) {
		throw new PaseoSetupUsageError(
			"--check and --remove cannot be combined: --check only reports, --remove mutates.",
		);
	}
	if (flags.mpreset !== undefined && flags.mpreset.trim() === "") {
		throw new PaseoSetupUsageError("--mpreset requires a preset name.");
	}
}

export async function runPaseoSetup(flags: PaseoSetupFlags, deps: PaseoSetupDependencies): Promise<PaseoSetupOutcome> {
	assertUsableFlags(flags);

	if (flags.check) {
		const result = await checkPaseoSetup(deps, { mpreset: flags.mpreset, force: flags.force });
		return { kind: "check", result };
	}

	if (flags.remove) {
		// `--check` is read-only and needs no lock. Install and remove mutate the
		// same intent record, provenance ledger, Paseo config targets, bridge, and
		// GJC settings, so both hold one per-agent-directory mutation lock from
		// recovery through the final provenance write: a concurrent remove cannot
		// clear the ledger while an install is still creating links and
		// registering the bridge.
		return await withPaseoMutationLock(deps, async () => {
			const recovery = await recoverIntent(deps.paths.intentRecord, {
				repair: true,
				expectedTargetPaths: [deps.paths.configJson, deps.paths.orchestrationPreferences, deps.paths.bridgeDir],
				expectedProvenancePath: deps.paths.provenanceLedger,
				replayBridgeCleanup: authority => replayPendingBridgeCleanup(deps, authority),
				trustedBridgePaths: await trustedBridgePathsForRecovery(deps),
			});
			if (recovery && !recovery.recovered) {
				return {
					kind: "remove",
					result: {
						outcome: "partial-removal",
						removed: [],
						remaining: [deps.paths.intentRecord],
						evidence: {
							failedStep: "intent-recovery",
							detail: recovery.detail,
							retained: [deps.paths.intentRecord],
						},
					},
				};
			}
			const settings = await Settings.init();
			const ledger = await readProvenance(deps.paths.provenanceLedger);
			// Unregister the LEDGER-RECORDED directory (the one GJC actually
			// registered at install time); after a path migration this can differ
			// from the current default bridge path.
			const result = await removePaseoSetup(
				deps,
				ledger.bridgePath === undefined
					? { now: deps.now() }
					: {
							now: deps.now(),
							unregisterBridgeDirectory: async () => {
								await unregisterBridgeDirectory(settings, ledger.bridgePath!);
							},
						},
			);
			return { kind: "remove", result };
		});
	}

	return {
		kind: "install",
		result: await withPaseoMutationLock(deps, () => installPaseoSetup(flags, deps)),
	};
}

/**
 * Resolve the bridge source once before bridge preflight so a source-less path
 * migration can refuse without allowing preflight to inspect the proposed
 * destination. Keep the fallback in lockstep with skills-bridge's resolver:
 * callers that omit the seam still get production discovery, followed by the
 * explicitly configured legacy user path.
 */
async function resolveSkillsBridgeSource(deps: PaseoSetupDependencies): Promise<PaseoSkillSource | undefined> {
	if (deps.skillsSource !== undefined) return deps.skillsSource();
	const discovered = await resolvePaseoSkillsSource();
	if (discovered !== undefined) return discovered;
	const configured = deps.paths.agentsSkillsDir;
	if (configured === undefined) return undefined;
	const stat = await fs.stat(configured).catch(() => undefined);
	return stat?.isDirectory() ? { dir: configured, origin: "user" } : undefined;
}

/**
 * Run the four-step install saga.
 *
 * Bridge preflight follows the source-less migration guard and is entirely
 * read-only, so the common failure cases (unparseable config, a conflicting
 * entry, an unresolvable executable, a foreign file sitting at one of our
 * bridge names) all abort before anything is written and therefore need no
 * compensation.
 */
async function installPaseoSetup(flags: PaseoSetupFlags, deps: PaseoSetupDependencies): Promise<PaseoInstallResult> {
	const now = deps.now();

	// An interrupted earlier run must be settled before starting a new one. A
	// discardable intent is cleared here; a `complete-ledger` intent whose ledger
	// contents are unknown to this run is reported rather than guessed at, and
	// the steps below re-derive and commit the same provenance anyway.
	const recovery = await recoverIntent(deps.paths.intentRecord, {
		repair: true,
		expectedTargetPaths: [deps.paths.configJson, deps.paths.orchestrationPreferences, deps.paths.bridgeDir],
		expectedProvenancePath: deps.paths.provenanceLedger,
		replayBridgeCleanup: authority => replayPendingBridgeCleanup(deps, authority),
		trustedBridgePaths: await trustedBridgePathsForRecovery(deps),
	});
	if (recovery && !recovery.recovered) {
		return {
			outcome: "partial-install",
			compensated: [],
			uncompensated: [deps.paths.intentRecord],
			evidence: { failedStep: "intent-recovery", detail: recovery.detail, retained: [deps.paths.intentRecord] },
		};
	}

	const resolution = resolveGjcCommand();
	if (!resolution.ok) {
		throw new PaseoSetupUsageError(
			`Cannot register GJC with Paseo: ${resolution.detail}. Paseo needs an absolute command path, so GJC will not write a bare 'gjc' string.`,
		);
	}

	const providerKey = providerKeyFor(flags.mpreset);
	const entry = buildProviderEntry(resolution.command, flags.mpreset);

	const config = await readTarget(deps.paths.configJson);
	const conflict = hasProviderConflict(config.parsed, providerKey, entry);
	if (conflict.conflict && !flags.force) {
		throw new PaseoSetupUsageError(`${conflict.detail} Re-run with --force to overwrite it.`);
	}
	const rawPriorValue = readRawProviderValue(config.parsed, providerKey);
	const existingMatches = rawPriorValue !== undefined && JSON.stringify(rawPriorValue) === JSON.stringify(entry);
	const replacedEntry = rawPriorValue !== undefined && !existingMatches ? rawPriorValue : undefined;
	if (replacedEntry !== undefined && !hasNoReparseSidecarAuthority()) {
		// A forced replacement needs a private sidecar for the exact prior
		// provider value. On Windows Node cannot open that sidecar with
		// no-reparse authority, so reject before the intent, target, or any
		// credential-bearing artifact is created. Existing cleanup provenance is
		// deliberately left untouched for a runtime with the required authority.
		throw new PaseoSetupUsageError(
			"Cannot use --force for an existing Paseo provider entry: this runtime cannot authenticate a no-reparse replacement sidecar; no credential-bearing sidecar or overwrite was created.",
		);
	}

	const preferences = await readTarget(deps.paths.orchestrationPreferences);
	const seed = createOrchestrationSeed(preferences.parsed);
	const bridgeLedgerBeforeInstall = await readProvenance(deps.paths.provenanceLedger);
	const recordedBridgePathBeforeInstall = bridgeLedgerBeforeInstall.bridgePath;
	const configuredBridgeCanonicalPath = await canonicalPathForComparison(deps.paths.bridgeDir);
	const recordedBridgeCanonicalPathBeforeInstall =
		recordedBridgePathBeforeInstall === undefined
			? undefined
			: await canonicalPathForComparison(recordedBridgePathBeforeInstall);
	const recordedBridgeIsMigration =
		recordedBridgePathBeforeInstall !== undefined &&
		recordedBridgeCanonicalPathBeforeInstall !== configuredBridgeCanonicalPath;
	const bridgeSource = await resolveSkillsBridgeSource(deps);
	// A path cutover cannot be authenticated without a live source. Refuse it
	// before any saga step so the existing bridge, registration, and complete
	// provenance ledger remain byte-for-byte unchanged.
	const sourceLessMigration =
		bridgeSource === undefined && recordedBridgePathBeforeInstall !== undefined && recordedBridgeIsMigration;
	// Refuse before bridge preflight can inspect the proposed destination. A
	// source-less cutover has no authenticated basis for changing the bridge
	// path, so the old registration, links, and ledger stay untouched.
	if (sourceLessMigration) {
		const failure = new SagaStepError(
			"install",
			`Refusing Paseo skills bridge path migration from ${recordedBridgePathBeforeInstall} to ${deps.paths.bridgeDir}: no resolved Paseo skills source is available; retaining the recorded bridge at ${recordedBridgePathBeforeInstall} and its registration`,
			[recordedBridgePathBeforeInstall!, deps.paths.provenanceLedger],
		);
		const outcome = await compensate([], failure);
		return { outcome: "partial-install", ...outcome };
	}
	const bridgePreflight = await preflightSkillsBridge({
		...deps,
		skillsSource: async () => bridgeSource,
	});
	// An empty resolved source cannot authenticate moving an existing bridge to
	// an absent destination: there are no links to establish at the new path,
	// so cutover would strand the recorded bridge and registration. An already
	// established destination remains eligible for normal convergence.
	const emptyResolvedSourceMigration =
		bridgeSource !== undefined &&
		recordedBridgePathBeforeInstall !== undefined &&
		recordedBridgeIsMigration &&
		bridgePreflight.bridgeDirCreated &&
		Object.keys(bridgePreflight.entries).length === 0 &&
		bridgePreflight.prunes.length === 0 &&
		bridgePreflight.adopts.length === 0;
	if (emptyResolvedSourceMigration) {
		const failure = new SagaStepError(
			"install",
			`Refusing Paseo skills bridge path migration from ${recordedBridgePathBeforeInstall} to ${deps.paths.bridgeDir}: the resolved Paseo skills source contains no bridgeable skills; retaining the recorded bridge at ${recordedBridgePathBeforeInstall} and its registration`,
			[recordedBridgePathBeforeInstall!, deps.paths.provenanceLedger],
		);
		const outcome = await compensate([], failure);
		return { outcome: "partial-install", ...outcome };
	}

	const completed: CompletedStep[] = [];
	const changed: string[] = [];
	const entryHash = providerEntryHash(entry);

	try {
		// Step 1: provider entry + provider-key provenance.
		//
		// Ownership is decided by what existed BEFORE this run, not by value
		// equality: an identical entry the user hand-wrote stays theirs (marked
		// pre-existing, never recorded in providerKeys), while a `--force`
		// overwrite stores the replaced entry so `--remove` restores it rather
		// than deleting content that was never GJC's to take.
		// The RAW prior value -- including scalars, arrays, and null -- is what a
		// `--force` overwrite replaces, so that is what must be restorable. An
		// object-shaped reader alone would lose a scalar/array/null prior and let
		// compensation delete user configuration instead of restoring it.
		// The prior value is preserved in a private sidecar beside Paseo's own
		// config, never in the ledger or intent record: a provider entry can
		// carry credential-bearing `env` or argument values, and GJC-side
		// durable state is credential-free by contract. The FIRST replaced
		// value is the user's; a repeated `--force` must not overwrite it, so
		// the sidecar is written only when the ledger holds no pointer yet.
		// The sidecar pointer is derived deterministically (injective path +
		// value digest), so the intent record can carry the full post-step
		// ledger before any artifact exists. The file itself is created by the
		// step's `persist` hook only after the CAS publish succeeded: a refused
		// or conflicting publish (#4644 review r8) must not strand an
		// unreferenced credential-bearing sidecar beside Paseo's config.
		const providerLedgerBefore = await readProvenance(deps.paths.provenanceLedger);
		const priorReplacedRef =
			replacedEntry !== undefined ? providerLedgerBefore.providerReplacedEntries?.[providerKey] : undefined;
		const preStepProviderKeys = { ...providerLedgerBefore.providerKeys };
		const preStepProviderPreexistingKeys = { ...providerLedgerBefore.providerPreexistingKeys };
		const preStepProviderReplacedEntries = { ...providerLedgerBefore.providerReplacedEntries };
		const preexistingSidecar =
			replacedEntry !== undefined && priorReplacedRef === undefined
				? await readReplacedProviderBackup(
						replacedProviderBackupPath(deps.paths.configJson, providerKey),
						providerKey,
						hashBytes(serializeJson(replacedEntry)),
					)
				: undefined;
		const createdReplacedRef =
			replacedEntry !== undefined && priorReplacedRef === undefined && preexistingSidecar?.found !== true
				? {
						backupPath: replacedProviderBackupPath(deps.paths.configJson, providerKey),
						valueSha256: hashBytes(serializeJson(replacedEntry)),
					}
				: undefined;
		const adoptedReplacedRef =
			replacedEntry !== undefined && priorReplacedRef === undefined && preexistingSidecar?.found === true
				? {
						backupPath: replacedProviderBackupPath(deps.paths.configJson, providerKey),
						valueSha256: hashBytes(serializeJson(replacedEntry)),
						createdByGjc: false,
					}
				: undefined;
		const replacedBackup = priorReplacedRef ?? createdReplacedRef ?? adoptedReplacedRef;
		// The intent carries a digest of the complete sidecar bytes before the
		// persist hook creates it. Recovery can therefore authenticate and remove
		// only the artifact this interrupted step intended to create, without
		// storing the credential-bearing value or consulting the ledger.
		const discardSidecar =
			createdReplacedRef !== undefined && replacedEntry !== undefined
				? {
						backupPath: createdReplacedRef.backupPath,
						valueSha256: hashBytes(serializeJson({ key: providerKey, value: replacedEntry })),
					}
				: undefined;
		let writtenBackupIdentity: PersistedFileIdentity | undefined;
		// The exact sidecar payload this run would create ({key,value} serialized);
		// unpersist deletes the file only when its CONTENT still hashes to these
		// authenticated bytes (#4644 reviews r16/r17 — size alone is spoofable and
		// omitted the {key,value} wrapper).
		const step1 = await runJsonStep({
			label: deps.paths.configJson,
			step: "provider-config",
			targetPath: deps.paths.configJson,
			provenancePath: deps.paths.provenanceLedger,
			intentPath: deps.paths.intentRecord,
			ownedKeys: [`agents.providers.${providerKey}`],
			// Ownership (pre-existing vs created vs replaced) was decided from the
			// preflight snapshot; a config that changed since is refused rather
			// than mutated under stale decisions (#4644 review r7).
			expectedPreflightIdentity: config.identity,
			mutate: createProviderMutation(config, providerKey, entry),
			nextLedger: ledger => ({
				...ledger,
				providerKeys: existingMatches
					? { ...ledger.providerKeys }
					: { ...ledger.providerKeys, [providerKey]: entryHash },
				providerPreexistingKeys: existingMatches
					? { ...ledger.providerPreexistingKeys, [providerKey]: true as const }
					: { ...ledger.providerPreexistingKeys },
				providerReplacedEntries:
					replacedBackup !== undefined
						? { ...ledger.providerReplacedEntries, [providerKey]: replacedBackup }
						: { ...ledger.providerReplacedEntries },
			}),
			// Compensation restores what this run actually replaced: a key GJC
			// created is removed, a key that carried ANY prior value (including a
			// scalar, array, or null) gets that exact value back, and an
			// identical pre-existing entry was never written and keeps its value.
			// An identical provider entry is explicitly pre-existing: the forward
			// step only records that fact and must not turn later compensation into
			// a deletion of the user's (or an earlier install's) unchanged value.
			revert: draft => {
				if (!existingMatches) restoreProviderKey(draft, providerKey, replacedEntry);
			},
			revertLedger: ledger => {
				// A repeated --force may replace a user edit while GJC already owns
				// this provider. Restore the exact provider provenance from before this
				// step, including the original replacement sidecar pointer, rather
				// than deleting the current key and orphaning its sidecar.
				return {
					...ledger,
					providerKeys: preStepProviderKeys,
					providerPreexistingKeys: preStepProviderPreexistingKeys,
					providerReplacedEntries: preStepProviderReplacedEntries,
				};
			},
			discardSidecar,
			persist:
				createdReplacedRef !== undefined
					? () =>
							writeReplacedProviderBackup(deps.paths.configJson, providerKey, replacedEntry).then(written => {
								writtenBackupIdentity = written.identity;
								if (written.identity !== undefined && createdReplacedRef !== undefined) {
									Object.assign(createdReplacedRef, { identity: written.identity });
									if (discardSidecar !== undefined)
										Object.assign(discardSidecar, { identity: written.identity });
								}
								if (
									!written.createdByGjc ||
									written.backupPath !== createdReplacedRef.backupPath ||
									written.valueSha256 !== createdReplacedRef.valueSha256
								) {
									throw new PaseoPublishError(written.backupPath, {
										reason: "sidecar-conflict",
										detail: `the sidecar for key ${providerKey} changed while GJC was preparing its update`,
									});
								}
							})
					: undefined,
			verifyPersisted:
				createdReplacedRef !== undefined
					? async () => {
							if (writtenBackupIdentity === undefined) {
								throw new PaseoPublishError(createdReplacedRef.backupPath, {
									reason: "sidecar-conflict",
									detail:
										"the replaced-provider sidecar was not identity-authenticated before config publication",
								});
							}
							const observed = await fs
								.lstat(createdReplacedRef.backupPath, { bigint: true })
								.catch(() => undefined);
							const preserved = await readReplacedProviderBackup(
								createdReplacedRef.backupPath,
								providerKey,
								createdReplacedRef.valueSha256,
								writtenBackupIdentity,
							);
							if (
								observed === undefined ||
								!observed.isFile() ||
								observed.isSymbolicLink() ||
								observed.dev.toString() !== writtenBackupIdentity.dev ||
								observed.ino.toString() !== writtenBackupIdentity.ino ||
								!preserved.found
							) {
								throw new PaseoPublishError(createdReplacedRef.backupPath, {
									reason: "sidecar-conflict",
									detail: "the replaced-provider sidecar changed before config publication",
								});
							}
						}
					: undefined,
			unpersist:
				createdReplacedRef !== undefined
					? async () => {
							// Only a sidecar THIS RUN created is removed (#4644
							// reviews r16/r17): the file is read fd-bound and its
							// CONTENT must hash to the exact {key,value} payload
							// this run wrote — a same-sized attacker replacement
							// fails the digest and is preserved, as is any
							// pre-existing sidecar (the user's value or a plant).
							const match = await readReplacedProviderBackup(
								createdReplacedRef.backupPath,
								providerKey,
								createdReplacedRef.valueSha256,
							);
							if (match.found) {
								const removed = await removeReplacedProviderBackup(
									createdReplacedRef.backupPath,
									providerKey,
									createdReplacedRef.valueSha256,
									writtenBackupIdentity,
								);
								if (!removed) {
									throw new PaseoPublishError(
										createdReplacedRef.backupPath,
										{
											reason: "sidecar-conflict",
											detail: "authenticated provider sidecar cleanup retained native authority",
										},
										[createdReplacedRef.backupPath],
									);
								}
							}
						}
					: undefined,
			now,
		});
		completed.push(step1.completed);
		if (step1.changed) changed.push(deps.paths.configJson);

		// Step 2: seed empty orchestration roles only.
		if (seed.seededKeys.length > 0) {
			const step2 = await runJsonStep({
				label: deps.paths.orchestrationPreferences,
				step: "orchestration-preferences",
				targetPath: deps.paths.orchestrationPreferences,
				provenancePath: deps.paths.provenanceLedger,
				intentPath: deps.paths.intentRecord,
				ownedKeys: [...seed.seededKeys],
				// Which roles are EMPTY (and therefore seedable) was decided from
				// the preflight snapshot; changed bytes refuse instead of seeding
				// roles a concurrent edit already filled (#4644 review r7).
				expectedPreflightIdentity: preferences.identity,
				mutate: seed.mutate,
				nextLedger: ledger => ({
					...ledger,
					seededOrchestrationKeys: { ...ledger.seededOrchestrationKeys, ...seed.seededValues },
				}),
				// Compensation must reach the same nested map the forward step wrote.
				revert: draft => removeSeededRoles(draft, seed.seededKeys, () => true),
				revertLedger: ledger => {
					const seededOrchestrationKeys = { ...ledger.seededOrchestrationKeys };
					for (const key of seed.seededKeys) delete seededOrchestrationKeys[key];
					return { ...ledger, seededOrchestrationKeys };
				},
				now,
			});
			completed.push(step2.completed);
			if (step2.changed) changed.push(deps.paths.orchestrationPreferences);
		}

		// Step 3: the symlink bridge. Install converges the bridge to the current
		// source (create missing, prune stale, adopt pre-#4638 legacy links).
		//
		// Provenance is committed BEFORE any link is created or pruned, and the
		// ownership set is exactly what GJC will own after this run: links it
		// created in an earlier run (the pre-existing non-noop entries), links
		// it adopts through the legacy migration, and -- until the prunes
		// complete -- the stale links it is about to remove, so a crash between
		// record and unlink still leaves every on-disk link covered. A `noop`
		// entry GJC did not previously record is deliberately NOT added: an
		// exact-target link the user created themselves must never become
		// GJC-owned just because a re-run observed it.
		const bridgeAmbiguities = bridgePreflight.ambiguities ?? [];
		const bridgeAmbiguityDetail = bridgeAmbiguities.map(ambiguity => ambiguity.detail).join("; ");
		const bridgeAmbiguityRetained = [
			...new Set([...bridgeAmbiguities.map(ambiguity => ambiguity.linkPath), deps.paths.provenanceLedger]),
		];
		// A source/path cutover would have to rewrite the ledger and retire the
		// old bridge. An identityless old link is not destructive authority, so
		// leave the entire bridge cutover untouched while still keeping the
		// provider and orchestration steps already committed above.
		if (bridgeAmbiguities.some(ambiguity => ambiguity.blocksBridgeCutover)) {
			return {
				outcome: "partial-install",
				compensated: [],
				uncompensated: bridgeAmbiguityRetained,
				evidence: {
					failedStep: "paseo skills bridge",
					detail: bridgeAmbiguityDetail,
					retained: bridgeAmbiguityRetained,
				},
			};
		}
		const bridgeLedger = await readProvenance(deps.paths.provenanceLedger);
		// A migration rollback may recreate old symlinks with fresh no-follow
		// identities. Compensation runs newest-first, so the old-link restoration
		// records those identities here for the later bridge inverse to carry into
		// the restored provenance instead of writing stale pre-cutover inodes.
		let compensatedOldBridgeEntryIdentities: Readonly<Record<string, BridgeEntryIdentity>> | undefined;
		let compensatedOldBridgeDirIdentity: BridgeEntryIdentity | undefined;
		// Migration binding: recorded ownership belongs to the recorded bridge
		// PATH, not to the skill names alone. When the agent/profile path moved,
		// the names are not carried over silently -- a user-owned exact-target
		// link at the new path must never inherit ownership from the old one,
		// and the old path's links are cleaned up explicitly instead of being
		// abandoned by the overwrite below.
		const recordedBridgePath = bridgeLedger.bridgePath;
		const [recordedBridgeCanonicalPath, configuredBridgeCanonicalPath] = await Promise.all([
			recordedBridgePath === undefined ? undefined : canonicalPathForComparison(recordedBridgePath),
			canonicalPathForComparison(deps.paths.bridgeDir),
		]);
		const isMigration =
			recordedBridgePath !== undefined && recordedBridgeCanonicalPath !== configuredBridgeCanonicalPath;
		let migratedOldEntries: readonly MigratedOldBridgeEntry[] = [];
		let migratedOldBridgeDir: string | undefined;
		let migratedOldBridgeDirIdentity: BridgeEntryIdentity | undefined;
		let migratedOldRegistrationPath: string | undefined;
		let migratedOldSourceDir: string | undefined;
		// An owned empty bridge still carries a settings registration and must
		// participate in the path cutover. `validatedBridgeDir` authenticates its
		// recorded directory identity before this branch can replace that
		// registration or hand the path to identity-bound cleanup.
		if (isMigration && ((bridgeLedger.bridgeEntries?.length ?? 0) > 0 || bridgeLedger.bridgeDirCreated === true)) {
			// The migration branch composes destructive cleanup paths from the
			// ledger's own bytes, so it must fail closed exactly like `--remove`
			// does: a tampered or malformed record (a `..` entry, a relative or
			// escaping bridge path) is refused, never fed to the unlinker.
			// The old bridge's links are removed only AFTER the new ledger and
			// settings cutover below is durable, as a compensable step, so a
			// later failure restores the old bridge instead of leaving the ledger
			// pointing at missing links.
			const oldBridgeDir = await validatedBridgeDir(bridgeLedger, deps);
			migratedOldSourceDir = bridgeLedger.bridgeSourceDir ?? legacySourceDirFor(deps);
			if (bridgeLedger.bridgeSourceDir !== undefined) {
				const sourceTrust = deps.trustedSkillsSource
					? await deps.trustedSkillsSource(migratedOldSourceDir)
					: await isTrustedRecordedSkillsSource(migratedOldSourceDir);
				if (!sourceTrust.ok) {
					throw new SagaStepError("paseo skills bridge", sourceTrust.detail, [
						migratedOldSourceDir,
						deps.paths.provenanceLedger,
					]);
				}
			}
			const capturedOldBridge = await captureMigratedOldBridgeEntries(
				oldBridgeDir,
				safeBridgeEntryNames(bridgeLedger.bridgeEntries ?? []),
				migratedOldSourceDir,
				bridgeLedger.bridgeEntryIdentities,
				bridgeLedger.bridgeDirIdentity,
			);
			if (capturedOldBridge.ambiguities.length > 0) {
				const retained = [
					...new Set([
						...capturedOldBridge.ambiguities.map(ambiguity => ambiguity.linkPath),
						deps.paths.provenanceLedger,
					]),
				];
				return {
					outcome: "partial-install",
					compensated: [],
					uncompensated: retained,
					evidence: {
						failedStep: "paseo skills bridge",
						detail: capturedOldBridge.ambiguities.map(ambiguity => ambiguity.detail).join("; "),
						retained,
					},
				};
			}
			migratedOldEntries = capturedOldBridge.entries;
			migratedOldBridgeDir = oldBridgeDir;
			migratedOldBridgeDirIdentity = capturedOldBridge.bridgeDirIdentity;
			migratedOldRegistrationPath = bridgeLedger.bridgePath;
		}
		const previouslyRecorded = isMigration ? new Set<string>() : new Set(bridgeLedger.bridgeEntries ?? []);
		// An identity-less entry may be a name written by the pre-mutation ledger
		// plan before link creation. An exact-target noop is not independent proof
		// that GJC created the live symlink, so preserve the missing receipt and let
		// removal fail closed until a durable per-entry identity exists.
		const bridgeEntryIdentities = bridgeLedger.bridgeEntryIdentities;
		const retainedAmbiguousNames = bridgeAmbiguities
			.filter(ambiguity => !ambiguity.blocksBridgeCutover)
			.map(ambiguity => ambiguity.name);
		const ownedAfterRun = [
			// Keep identityless recorded names in the ledger as evidence, but never
			// manufacture identities or let them become newly owned at another path.
			...(isMigration
				? []
				: (bridgeLedger.bridgeEntries ?? []).filter(name => retainedAmbiguousNames.includes(name))),
			// Entries this run or an earlier run actually creates/recreates.
			...Object.values(bridgePreflight.entries)
				.filter(entry => entry.action !== "noop" || (previouslyRecorded.has(entry.name) && entry.action === "noop"))
				.map(entry => entry.name),
			// Legacy links GJC adopts become owned at their new target.
			...bridgePreflight.adopts.map(adopt => adopt.name),
			// Prune candidates stay recorded until the unlink completes below;
			// the post-install write then drops them.
			...bridgePreflight.prunes.map(prune => prune.name),
		].filter((name, index, all) => all.indexOf(name) === index);
		const hasBridgeWork = ownedAfterRun.length > 0 || bridgePreflight.bridgeDirCreated;
		// A fresh no-source run owns NOTHING (#4644 review r8): the preflight's
		// `bridgeDirCreated` is a PLAN (the directory is absent), not a fact, and
		// `installSkillsBridge` skips creation entirely when there is no work. A
		// ledger that recorded the plan as fact would let a later `--remove` trust
		// false ownership of a directory GJC never created and delete user work
		// that later appeared at that path. Nothing is recorded at all.
		if (
			bridgePreflight.sourceDir === undefined &&
			!ledgerOwnsBridge(bridgeLedger) &&
			bridgePreflight.bridgeDirCreated
		) {
			if (bridgeAmbiguities.length > 0) {
				return {
					outcome: "partial-install",
					compensated: [],
					uncompensated: bridgeAmbiguityRetained,
					evidence: {
						failedStep: "paseo skills bridge",
						detail: bridgeAmbiguityDetail,
						retained: bridgeAmbiguityRetained,
					},
				};
			}
			return { outcome: "installed", changed: [...changed, "paseo skills bridge (no source)"] };
		}
		// A resolved source containing no `paseo*` skills is an intentional
		// no-bridge state: `installSkillsBridge` will create neither the
		// directory nor any link, so persisting a bridge path here would record
		// a directory GJC never created and registering it would globally load
		// whatever foreign content later appears at that path. Provenance and
		// registration are both skipped; the ledger keeps whatever it had.
		const intentionalNoBridge =
			bridgePreflight.sourceDir !== undefined &&
			ownedAfterRun.length === 0 &&
			Object.keys(bridgePreflight.entries).length === 0 &&
			bridgePreflight.adopts.length === 0 &&
			bridgePreflight.prunes.length === 0 &&
			// A bridge directory GJC created and still owns (an earlier run pruned
			// the final entry) keeps its provenance: clearing the record would
			// strand an owned directory and its registration. The no-bridge state
			// applies only when the ledger owns no bridge at all.
			bridgeLedger.bridgeDirCreated !== true &&
			bridgeLedger.bridgePath === undefined &&
			bridgeAmbiguities.length === 0;
		if (intentionalNoBridge) {
			await writeProvenance(deps.paths.provenanceLedger, {
				...bridgeLedger,
				bridgePath: undefined,
				bridgeEntries: [],
				bridgeEntryIdentities: {},
				bridgeDirCreated: false,
				bridgeSourceDir: undefined,
			});
			return { outcome: "installed", changed: [...changed, "paseo skills bridge (empty source)"] };
		}
		// Nothing provably owned needs a bridge mutation. Keep the existing ledger,
		// registration, and ambiguous link byte-for-byte intact while reporting the
		// partial reconciliation after the independent JSON steps succeeded.
		if (
			bridgeAmbiguities.length > 0 &&
			Object.keys(bridgePreflight.entries).length === 0 &&
			bridgePreflight.prunes.length === 0 &&
			bridgePreflight.adopts.length === 0 &&
			!bridgePreflight.bridgeDirCreated
		) {
			return {
				outcome: "partial-install",
				compensated: [],
				uncompensated: bridgeAmbiguityRetained,
				evidence: {
					failedStep: "paseo skills bridge",
					detail: bridgeAmbiguityDetail,
					retained: bridgeAmbiguityRetained,
				},
			};
		}
		let bridgeLedgerAfter: ProvenanceLedger | undefined;
		let bridgeIntentWritten = false;
		if (hasBridgeWork || bridgePreflight.sourceDir !== undefined) {
			bridgeLedgerAfter = {
				...bridgeLedger,
				bridgePath: deps.paths.bridgeDir,
				bridgeEntries: ownedAfterRun,
				bridgeEntryIdentities,
				// `bridgeDirCreated` records whether GJC created THIS directory,
				// so `--remove` knows whether the empty directory is ours to
				// delete. It is per-path FACT ownership (#4644 review r8): this
				// pre-write carries only what an earlier run actually created --
				// never the preflight's plan -- and the creator bit for a freshly
				// created directory is committed below, only after the exclusive
				// `mkdir` inside `installSkillsBridge` succeeded. A crash before
				// that point leaves an honest `false`; a concurrent creator making
				// the `mkdir` fail EEXIST leaves an honest `false` too.
				bridgeDirCreated: isMigration ? false : bridgeLedger.bridgeDirCreated === true,
				...(bridgePreflight.sourceDir !== undefined ? { bridgeSourceDir: bridgePreflight.sourceDir } : {}),
			};
			const bridgeIntent: IntentRecord = {
				version: INTENT_VERSION,
				step: "skills-bridge",
				targetPath: deps.paths.bridgeDir,
				ownedKeys: ["paseo.skills-bridge"],
				targetPreflightIdentity: provenanceLedgerIdentity(bridgeLedger),
				targetExpectedIdentity: provenanceLedgerIdentity(bridgeLedger),
				provenancePath: deps.paths.provenanceLedger,
				provenancePreflightIdentity: await currentIdentity(deps.paths.provenanceLedger),
				provenanceExpectedIdentity: provenanceLedgerIdentity(bridgeLedgerAfter),
				provenancePayload: bridgeLedgerAfter,
				bridgePreflightPayload: bridgeLedger,
				startedAt: now.toISOString(),
			};
			await writeIntent(deps.paths.intentRecord, bridgeIntent);
			bridgeIntentWritten = true;
		}
		let bridge: SkillsBridgeInstallResult;
		try {
			bridge = await installSkillsBridge(bridgePreflight);
		} catch (error) {
			// A mid-operation bridge failure must not leave the pre-write's
			// PLAN standing as provenance FACT (#4644 review r9): the failed
			// install carries what actually completed, so the ledger is
			// corrected to observed reality — prior entries minus completed
			// prunes plus created/adopted links — before the saga error
			// propagates. Never-created planned entries stop being claimed;
			// `--check` reports no phantom missing-bridge-link drift and
			// `--remove` sees exactly the links that exist.
			if (error instanceof SkillsBridgePartialError) {
				await correctBridgeOwnershipAfterFailure(deps, bridgeLedger, isMigration, error.partial);
			}
			throw error;
		}
		// The directory was exclusively created a moment ago: directory ownership
		// is persisted only now that the creation actually succeeded (#4644
		// review r8), never from the preflight's plan.
		if (bridge.bridgeDirCreated && bridge.bridgeDirIdentity !== undefined) {
			bridgeLedgerAfter = {
				...(bridgeLedgerAfter ?? bridgeLedger),
				bridgeDirCreated: true,
				bridgeDirIdentity: bridge.bridgeDirIdentity,
			};
		}
		if (Object.keys(bridge.entryIdentities).length > 0) {
			bridgeLedgerAfter = {
				...(bridgeLedgerAfter ?? bridgeLedger),
				bridgeEntryIdentities: {
					...(bridgeLedgerAfter?.bridgeEntryIdentities ?? bridgeLedger.bridgeEntryIdentities),
					...bridge.entryIdentities,
				},
			};
		}
		// Prunes have completed: drop them from the ownership record so a later
		// `--remove` does not treat the removed names as still owned.
		if (bridgePreflight.prunes.length > 0) {
			bridgeLedgerAfter = {
				...(bridgeLedgerAfter ?? bridgeLedger),
				bridgeEntries: (bridgeLedgerAfter?.bridgeEntries ?? bridgeLedger.bridgeEntries ?? []).filter(
					name => !bridge.prunedEntries.includes(name),
				),
				bridgeEntryIdentities: Object.fromEntries(
					Object.entries(
						bridgeLedgerAfter?.bridgeEntryIdentities ?? bridgeLedger.bridgeEntryIdentities ?? {},
					).filter(([name]) => !bridge.prunedEntries.includes(name)),
				),
			};
		}
		if (
			bridge.createdEntries.length > 0 ||
			bridge.prunedEntries.length > 0 ||
			bridge.adoptedEntries.length > 0 ||
			bridge.bridgeDirCreated
		) {
			changed.push(deps.paths.bridgeDir);
			completed.push({
				label: deps.paths.bridgeDir,
				undo: async () => {
					try {
						await inverseSkillsBridge(deps, bridge, {
							onCleanupPending: authority =>
								persistBridgeCleanupPending(deps, authority, DESTINATION_ROLLBACK_CLEANUP),
						});
						// The bridge ledger was prewritten to make the forward mutation
						// recoverable. The inverse also restores captured legacy link text
						// for adopted entries before the pre-step bridge facts are restored,
						// so later checks cannot report phantom links or ownership.
						const current = await readProvenance(deps.paths.provenanceLedger);
						const restoredLedger: ProvenanceLedger = {
							...current,
							bridgePath: bridgeLedger.bridgePath,
							bridgeSourceDir: bridgeLedger.bridgeSourceDir,
							bridgeEntries: bridgeLedger.bridgeEntries,
							bridgeEntryIdentities: compensatedOldBridgeEntryIdentities ?? bridgeLedger.bridgeEntryIdentities,
							bridgeDirCreated: bridgeLedger.bridgeDirCreated,
							bridgeDirIdentity: compensatedOldBridgeDirIdentity ?? bridgeLedger.bridgeDirIdentity,
							bridgeCleanupPending: undefined,
						};
						const intent = await readIntent(deps.paths.intentRecord);
						if (intent?.step === "skills-bridge" && intent.provenancePath === deps.paths.provenanceLedger) {
							await writeIntent(deps.paths.intentRecord, {
								...intent,
								provenancePreflightIdentity: provenanceLedgerIdentity(current),
								bridgePreflightPayload: current,
								provenanceExpectedIdentity: provenanceLedgerIdentity(restoredLedger),
								provenancePayload: restoredLedger,
							});
						}
						await writeProvenance(deps.paths.provenanceLedger, restoredLedger);
						if (intent?.step === "skills-bridge") await clearIntent(deps.paths.intentRecord);
						return { status: "reverted" as const };
					} catch (error) {
						return {
							status: "conflict" as const,
							detail: error instanceof Error ? error.message : String(error),
							retained: [deps.paths.bridgeDir, ...(error instanceof SkillsBridgeError ? error.retained : [])],
						};
					}
				},
			});
		}
		if (bridgeIntentWritten && bridgeLedgerAfter !== undefined) {
			await writeIntent(deps.paths.intentRecord, {
				version: INTENT_VERSION,
				step: "skills-bridge",
				targetPath: deps.paths.bridgeDir,
				ownedKeys: ["paseo.skills-bridge"],
				targetPreflightIdentity: provenanceLedgerIdentity(bridgeLedger),
				targetExpectedIdentity: provenanceLedgerIdentity(bridgeLedger),
				provenancePath: deps.paths.provenanceLedger,
				provenancePreflightIdentity: await currentIdentity(deps.paths.provenanceLedger),
				provenanceExpectedIdentity: provenanceLedgerIdentity(bridgeLedgerAfter),
				provenancePayload: bridgeLedgerAfter,
				bridgePreflightPayload: bridgeLedger,
				startedAt: now.toISOString(),
			});
		}

		// Step 4: register the bridge with GJC skill discovery -- only when the
		// bridge was validated against a real source this run. Registering an
		// existing directory that no source validates and no ledger owns would
		// globally load whatever a stale or foreign bridge contains. A migration
		// REPLACES the old recorded registration in the same atomic commit, so
		// the stale path cannot survive the cutover.
		if (bridgePreflight.sourceDir === undefined && !ledgerOwnsBridge(bridgeLedger)) {
			// The fresh absent-directory case returned before any provenance was
			// written; what remains is an existing directory no source validates
			// and no ledger owns, which must never be registered globally.
			throw new SagaStepError(
				"install",
				`Refusing to register Paseo skills bridge without a validated source or ownership record (${deps.paths.bridgeDir}); re-run after Paseo is installed or point PASEO_SKILLS_DIR at the real skills directory`,
			);
		}
		const settings = await Settings.init();
		const receipt = await registerSkillsBridgeDirectory(settings, deps.paths.bridgeDir, {
			...(migratedOldRegistrationPath !== undefined
				? { replaces: migratedOldRegistrationPath }
				: migratedOldBridgeDir !== undefined
					? { replaces: migratedOldBridgeDir }
					: {}),
		});
		completed.push(receiptStep("config.yml skills.customDirectories", receipt));
		changed.push("config.yml skills.customDirectories");

		// The new ledger and settings cutover is now durable, so the old bridge
		// can be retired as its own compensable step: on a later failure the old
		// links are restored to the old directory (the registration receipt above
		// already reverts the swap), instead of stranding a ledger that points at
		// links that no longer exist.
		if (
			migratedOldBridgeDir !== undefined &&
			(migratedOldEntries.length > 0 || bridgeLedger.bridgeDirCreated === true)
		) {
			const oldSourceDir = migratedOldSourceDir ?? bridgeLedger.bridgeSourceDir ?? legacySourceDirFor(deps);
			const oldCleanup = {
				createdEntries: migratedOldEntries.map(entry => entry.name),
				prunedEntries: [],
				adoptedEntries: [],
				entryIdentities: Object.fromEntries(migratedOldEntries.map(entry => [entry.name, entry.identity])),
				bridgeDirCreated: bridgeLedger.bridgeDirCreated ?? false,
				bridgeDirIdentity: migratedOldBridgeDirIdentity ?? bridgeLedger.bridgeDirIdentity,
				sourceDir: oldSourceDir,
			};
			// Register the compensable step BEFORE the first old-link unlink. A
			// syscall can fail after inverseSkillsBridge has already removed one
			// of several entries; keeping the pre-cutover link text and identity
			// here lets compensation restore only those removals, without ever
			// replacing a successor that claimed the pathname.
			completed.push({
				label: migratedOldBridgeDir,
				undo: async () => {
					const currentLedger = await readProvenance(deps.paths.provenanceLedger);
					if (
						currentLedger.bridgeCleanupPending !== undefined &&
						path.resolve(currentLedger.bridgeCleanupPending.originalPath) !== path.resolve(migratedOldBridgeDir!)
					) {
						return {
							status: "conflict" as const,
							detail: `migration cleanup authority targets a different bridge: ${currentLedger.bridgeCleanupPending.originalPath}`,
							retained: [migratedOldBridgeDir!, currentLedger.bridgeCleanupPending.detachedPath],
						};
					}
					const restored = await restoreMigratedOldBridgeEntries(
						migratedOldBridgeDir!,
						migratedOldEntries,
						bridgeLedger.bridgeDirCreated === true,
						migratedOldBridgeDirIdentity,
						currentLedger.bridgeCleanupPending,
					);
					if (restored.status === "reverted") {
						compensatedOldBridgeEntryIdentities = {
							...(bridgeLedger.bridgeEntryIdentities ?? {}),
							...restored.entryIdentities,
						};
						compensatedOldBridgeDirIdentity = restored.bridgeDirIdentity;
						if (!completed.some(step => step.label === deps.paths.bridgeDir)) {
							const current = await readProvenance(deps.paths.provenanceLedger);
							const settled: ProvenanceLedger = {
								...current,
								bridgePath: bridgeLedger.bridgePath,
								bridgeSourceDir: bridgeLedger.bridgeSourceDir,
								bridgeEntries: bridgeLedger.bridgeEntries,
								bridgeEntryIdentities: compensatedOldBridgeEntryIdentities,
								bridgeDirCreated: bridgeLedger.bridgeDirCreated,
								bridgeDirIdentity: compensatedOldBridgeDirIdentity ?? bridgeLedger.bridgeDirIdentity,
								bridgeCleanupPending: undefined,
							};
							const intent = await readIntent(deps.paths.intentRecord);
							if (intent?.step === "skills-bridge") {
								await writeIntent(deps.paths.intentRecord, {
									...intent,
									provenancePreflightIdentity: provenanceLedgerIdentity(current),
									bridgePreflightPayload: current,
									provenanceExpectedIdentity: provenanceLedgerIdentity(settled),
									provenancePayload: settled,
								});
							}
							await writeProvenance(deps.paths.provenanceLedger, settled);
							if (intent?.step === "skills-bridge") await clearIntent(deps.paths.intentRecord);
						}
					}
					return restored;
				},
			});
			try {
				await inverseSkillsBridge(deps, oldCleanup, {
					bridgeDir: migratedOldBridgeDir,
					onCleanupPending: authority => persistBridgeCleanupPending(deps, authority, MIGRATION_FORWARD_CLEANUP),
				});
			} catch (error) {
				throw new SagaStepError(
					"install",
					`bridge path migrated from ${recordedBridgePath} but the old bridge could not be cleaned: ${error instanceof Error ? error.message : String(error)}`,
					[migratedOldBridgeDir, ...(error instanceof SkillsBridgeError ? error.retained : [])],
				);
			}
			changed.push(migratedOldBridgeDir);
		}
		if (bridgeIntentWritten && bridgeLedgerAfter !== undefined) {
			try {
				await writeProvenance(deps.paths.provenanceLedger, bridgeLedgerAfter);
				await clearIntent(deps.paths.intentRecord);
			} catch (error) {
				if (error instanceof ProvenancePublicationUncertainError) {
					return {
						outcome: "partial-install",
						compensated: [],
						uncompensated: [deps.paths.intentRecord, deps.paths.provenanceLedger, deps.paths.bridgeDir],
						evidence: {
							failedStep: "paseo skills bridge",
							detail: error.message,
							retained: [deps.paths.intentRecord, deps.paths.provenanceLedger, deps.paths.bridgeDir],
						},
					};
				}
				throw error;
			}
		}
		if (bridgeAmbiguities.length > 0) {
			return {
				outcome: "partial-install",
				compensated: [],
				uncompensated: bridgeAmbiguityRetained,
				evidence: {
					failedStep: "paseo skills bridge",
					detail: bridgeAmbiguityDetail,
					retained: bridgeAmbiguityRetained,
				},
			};
		}
	} catch (error) {
		const failure =
			error instanceof SagaStepError
				? error
				: new SagaStepError(
						"install",
						error instanceof PaseoPublishError || error instanceof Error ? error.message : String(error),
						error instanceof SkillsBridgeError ? error.retained : [],
					);
		if (failure.preserveState) {
			return {
				outcome: "partial-install",
				compensated: [],
				uncompensated: failure.retained,
				evidence: { failedStep: failure.label, detail: failure.message, retained: failure.retained },
			};
		}
		const outcome = await compensate(completed, failure);
		return { outcome: "partial-install", ...outcome };
	}

	return { outcome: "installed", changed };
}

type MigratedOldBridgeEntry = {
	readonly name: string;
	readonly linkText: string;
	readonly identity: BridgeEntryIdentity;
};

type MigratedOldBridgeCapture = {
	readonly entries: readonly MigratedOldBridgeEntry[];
	readonly ambiguities: readonly SkillsBridgeAmbiguity[];
	readonly bridgeDirIdentity?: BridgeEntryIdentity;
};

/**
 * Capture the exact old links before migration cutover. A durable per-entry
 * identity is required before migration may remove a link: a prewritten name
 * and matching target can still describe a user-created symlink.
 */
async function captureMigratedOldBridgeEntries(
	bridgeDir: string,
	names: readonly string[],
	sourceDir: string,
	recordedIdentities: Readonly<Record<string, BridgeEntryIdentity>> | undefined,
	recordedBridgeDirIdentity: BridgeEntryIdentity | undefined,
): Promise<MigratedOldBridgeCapture> {
	const captured: MigratedOldBridgeEntry[] = [];
	const ambiguities: SkillsBridgeAmbiguity[] = [];
	const directory = await fs.lstat(bridgeDir, { bigint: true }).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new SkillsBridgeError(`Cannot inspect old Paseo skill bridge directory: ${bridgeDir}`);
	});
	if (directory !== undefined && (!directory.isDirectory() || directory.isSymbolicLink())) {
		throw new SkillsBridgeError(`Refusing to migrate a non-directory old Paseo skill bridge: ${bridgeDir}`);
	}
	if (
		directory !== undefined &&
		recordedBridgeDirIdentity !== undefined &&
		(directory.dev.toString() !== recordedBridgeDirIdentity.dev ||
			directory.ino.toString() !== recordedBridgeDirIdentity.ino)
	) {
		throw new SkillsBridgeError(`Refusing to migrate a replaced old Paseo skill bridge directory: ${bridgeDir}`);
	}
	const bridgeDirIdentity =
		directory === undefined
			? undefined
			: {
					dev: directory.dev.toString(),
					ino: directory.ino.toString(),
					size: directory.size.toString(),
					mtimeNs: directory.mtimeNs.toString(),
				};
	for (const name of names) {
		const destination = path.join(bridgeDir, name);
		const stat = await fs.lstat(destination, { bigint: true }).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new SkillsBridgeError(`Cannot inspect old Paseo skill bridge entry: ${destination}`);
		});
		if (stat === undefined) continue;
		if (!stat.isSymbolicLink()) {
			throw new SkillsBridgeError(`Refusing to migrate a non-symlink old Paseo skill bridge entry: ${destination}`);
		}
		const linkText = await fs.readlink(destination);
		if (path.resolve(path.dirname(destination), linkText) !== path.resolve(sourceDir, name)) {
			throw new SkillsBridgeError(
				`Refusing to migrate an old Paseo skill bridge entry with a foreign target: ${destination}`,
			);
		}
		const observed: BridgeEntryIdentity = {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: stat.size.toString(),
			mtimeNs: stat.mtimeNs.toString(),
		};
		const recorded = recordedIdentities?.[name];
		if (recorded === undefined) {
			// Pre-identity ledgers cannot prove that this matching link is still
			// the object GJC created. Preserve the ambiguous pathname and stop the
			// migration before it can rewrite the bridge path or registration.
			ambiguities.push({
				name,
				linkPath: destination,
				detail: `preserving an identityless recorded Paseo bridge link; its ownership cannot be authenticated (${destination})`,
				blocksBridgeCutover: true,
			});
			continue;
		}
		if (!sameBridgeEntryIdentity(recorded, observed)) {
			throw new SkillsBridgeError(`Refusing to migrate a changed old Paseo skill bridge entry: ${destination}`);
		}
		captured.push({ name, linkText, identity: recorded });
	}
	return { entries: captured, ambiguities, ...(bridgeDirIdentity ? { bridgeDirIdentity } : {}) };
}

async function recreateOwnedBridgeDirectory(bridgeDir: string): Promise<BridgeEntryIdentity> {
	const temporary = await fs.mkdtemp(path.join(path.dirname(bridgeDir), ".paseo-bridge-restore-"));
	let stagedSnapshot: NativeDirectoryTreeResult | undefined;
	let identity: BridgeEntryIdentity | undefined;
	let cleanupError: string | undefined;
	try {
		await fs.chmod(temporary, 0o700);
		stagedSnapshot = snapshotDirectoryTree(temporary);
		const stat = await fs.lstat(temporary, { bigint: true });
		const published = renameNoReplacePath(
			canonicalExistingPathForNative(temporary),
			canonicalExistingPathForNative(bridgeDir),
			{
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
			},
		);
		if (!published.ok) {
			throw new SkillsBridgeError(
				`old Paseo bridge directory appeared during compensation: ${bridgeDir} (${published.code ?? published.reason})`,
			);
		}
		identity = {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: stat.size.toString(),
			mtimeNs: stat.mtimeNs.toString(),
		};
	} finally {
		if (stagedSnapshot?.ok && stagedSnapshot.snapshot !== undefined) {
			const cleanup = exactRemoveDirectoryTree(canonicalExistingPathForNative(temporary), stagedSnapshot.snapshot);
			if (!cleanup.ok && cleanup.code !== "not_found")
				cleanupError = `Paseo bridge staging cleanup retained authority: ${temporary}`;
		}
	}
	if (cleanupError !== undefined) throw new SkillsBridgeError(cleanupError, [temporary]);
	if (identity === undefined) throw new SkillsBridgeError(`Paseo bridge identity was not captured: ${temporary}`);
	return identity;
}

/** Restore only old links that the migration inverse actually removed. */
async function restoreMigratedOldBridgeEntries(
	bridgeDir: string,
	entries: readonly MigratedOldBridgeEntry[],
	bridgeDirCreated: boolean,
	expectedBridgeDirIdentity: BridgeEntryIdentity | undefined,
	pendingAuthority: BridgeCleanupAuthority | undefined,
): Promise<
	| {
			readonly status: "reverted";
			readonly entryIdentities: Readonly<Record<string, BridgeEntryIdentity>>;
			readonly bridgeDirIdentity?: BridgeEntryIdentity;
	  }
	| { readonly status: "conflict"; readonly detail: string; readonly retained: readonly string[] }
> {
	const missing: MigratedOldBridgeEntry[] = [];
	const entryIdentities: Record<string, BridgeEntryIdentity> = Object.fromEntries(
		entries.map(entry => [entry.name, entry.identity]),
	);
	try {
		if (pendingAuthority !== undefined) {
			try {
				await replayBridgeCleanup(pendingAuthority);
			} catch (error) {
				return {
					status: "conflict",
					detail: `old Paseo bridge cleanup authority could not be replayed during compensation: ${error instanceof Error ? error.message : String(error)}`,
					retained: [bridgeDir, pendingAuthority.detachedPath],
				};
			}
		}
		const existingDirectory = await fs.lstat(bridgeDir, { bigint: true }).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (existingDirectory !== undefined && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) {
			return {
				status: "conflict",
				detail: `old Paseo bridge directory was replaced during compensation: ${bridgeDir}`,
				retained: [bridgeDir],
			};
		}
		if (
			existingDirectory !== undefined &&
			expectedBridgeDirIdentity !== undefined &&
			(existingDirectory.dev.toString() !== expectedBridgeDirIdentity.dev ||
				existingDirectory.ino.toString() !== expectedBridgeDirIdentity.ino)
		) {
			return {
				status: "conflict",
				detail: `old Paseo bridge directory was replaced during compensation: ${bridgeDir}`,
				retained: [bridgeDir],
			};
		}
		if (existingDirectory === undefined && !bridgeDirCreated && entries.length > 0) {
			return {
				status: "conflict",
				detail: `old Paseo bridge directory disappeared during compensation: ${bridgeDir}`,
				retained: [bridgeDir],
			};
		}
		let recreatedDirectory = false;
		let activeDirectoryIdentity =
			existingDirectory === undefined
				? undefined
				: {
						dev: existingDirectory.dev.toString(),
						ino: existingDirectory.ino.toString(),
						size: existingDirectory.size.toString(),
						mtimeNs: existingDirectory.mtimeNs.toString(),
					};
		if (existingDirectory === undefined && bridgeDirCreated) {
			activeDirectoryIdentity = await recreateOwnedBridgeDirectory(bridgeDir);
			recreatedDirectory = true;
		}
		// A removed old root is recreated under a unique temporary name, captured
		// by identity, and moved into place with no-replace semantics. The
		// identity therefore remains authoritative even if the pathname is
		// replaced before the first restored link is published.
		const activeDirectory = async (): Promise<boolean> => {
			const current = await fs.lstat(bridgeDir, { bigint: true }).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			if (current === undefined || !current.isDirectory() || current.isSymbolicLink()) return false;
			if (activeDirectoryIdentity === undefined) return true;
			const expected = activeDirectoryIdentity;
			return current.dev.toString() === expected.dev && current.ino.toString() === expected.ino;
		};
		if (!(await activeDirectory())) {
			return {
				status: "conflict",
				detail: `old Paseo bridge directory changed before compensation: ${bridgeDir}`,
				retained: [bridgeDir],
			};
		}
		for (const entry of entries) {
			// Re-check the same root identity before every observation. A pathname
			// swap between entries must never let a successor provide evidence for
			// this rollback.
			if (!(await activeDirectory())) {
				return {
					status: "conflict",
					detail: `old Paseo bridge directory changed during compensation: ${bridgeDir}`,
					retained: [bridgeDir],
				};
			}
			const destination = path.join(bridgeDir, entry.name);
			const stat = await fs.lstat(destination, { bigint: true }).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw new SkillsBridgeError(
					`cannot inspect old Paseo skill bridge entry during compensation: ${destination}`,
				);
			});
			if (stat === undefined) {
				missing.push(entry);
				continue;
			}
			if (!stat.isSymbolicLink()) {
				return {
					status: "conflict",
					detail: `old Paseo skill bridge entry was replaced during compensation: ${destination}`,
					retained: [bridgeDir],
				};
			}
			const linkText = await fs.readlink(destination);
			if (!(await activeDirectory())) {
				return {
					status: "conflict",
					detail: `old Paseo bridge directory changed during compensation: ${bridgeDir}`,
					retained: [bridgeDir],
				};
			}
			const observed: BridgeEntryIdentity = {
				dev: stat.dev.toString(),
				ino: stat.ino.toString(),
				size: stat.size.toString(),
				mtimeNs: stat.mtimeNs.toString(),
			};
			// An untouched original is already restored. A same-target successor
			// is not: its identity differs, so compensation must not clobber it.
			if (linkText !== entry.linkText || !sameBridgeEntryIdentity(observed, entry.identity)) {
				return {
					status: "conflict",
					detail: `old Paseo skill bridge entry changed during compensation: ${destination}`,
					retained: [bridgeDir],
				};
			}
		}

		for (const entry of missing) {
			const destination = path.join(bridgeDir, entry.name);
			if (!(await activeDirectory())) {
				return {
					status: "conflict",
					detail: `old Paseo bridge directory changed during compensation: ${bridgeDir}`,
					retained: [bridgeDir],
				};
			}
			// No replacement: the native operation retains the expected bridge-root
			// descriptor through the create mutation. EEXIST and a swapped root are
			// structured pre-mutation conflicts; no pathname-only symlink fallback is
			// permitted here.
			if (activeDirectoryIdentity === undefined) {
				return {
					status: "conflict",
					detail: `old Paseo bridge directory identity was unavailable during compensation: ${bridgeDir}`,
					retained: [bridgeDir],
				};
			}
			const created = symlinkNoReplacePath(entry.linkText, canonicalExistingPathForNative(destination), {
				dev: BigInt(activeDirectoryIdentity.dev),
				ino: BigInt(activeDirectoryIdentity.ino),
			});
			if (!created.ok) {
				return {
					status: "conflict",
					detail: `old Paseo skill bridge entry could not be restored at the identity-bound mutation boundary: ${destination} (${created.code ?? created.reason})`,
					retained: [bridgeDir],
				};
			}
			const restored = await fs.lstat(destination, { bigint: true });
			if (!restored.isSymbolicLink() || (await fs.readlink(destination)) !== entry.linkText) {
				return {
					status: "conflict",
					detail: `old Paseo skill bridge entry could not be proven restored: ${destination}`,
					retained: [bridgeDir],
				};
			}
			entryIdentities[entry.name] = {
				dev: restored.dev.toString(),
				ino: restored.ino.toString(),
				size: restored.size.toString(),
				mtimeNs: restored.mtimeNs.toString(),
			};
		}
		let restoredDirectory: BridgeEntryIdentity | undefined;
		if (recreatedDirectory) {
			// The final lstat is still authenticated against the identity captured
			// immediately after mkdir. A late replacement may not become rollback
			// authority merely because it occupies the same pathname now.
			const finalDirectory = await fs.lstat(bridgeDir, { bigint: true }).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			if (
				finalDirectory === undefined ||
				!finalDirectory.isDirectory() ||
				finalDirectory.isSymbolicLink() ||
				activeDirectoryIdentity === undefined ||
				finalDirectory.dev.toString() !== activeDirectoryIdentity.dev ||
				finalDirectory.ino.toString() !== activeDirectoryIdentity.ino
			) {
				return {
					status: "conflict",
					detail: `old Paseo bridge directory changed during compensation: ${bridgeDir}`,
					retained: [bridgeDir],
				};
			}
			// Keep the recreated object's dev/ino as authority while accepting the
			// current metadata for diagnostics and later persistence.
			restoredDirectory = {
				...activeDirectoryIdentity,
				size: finalDirectory.size.toString(),
				mtimeNs: finalDirectory.mtimeNs.toString(),
			};
		}
		return {
			status: "reverted",
			entryIdentities,
			...(restoredDirectory ? { bridgeDirIdentity: restoredDirectory } : {}),
		};
	} catch (error) {
		return {
			status: "conflict",
			detail: `old Paseo skill bridge compensation failed: ${error instanceof Error ? error.message : String(error)}`,
			retained: [bridgeDir],
		};
	}
}

function sameBridgeEntryIdentity(left: BridgeEntryIdentity, right: BridgeEntryIdentity): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
	);
}

/** True when the ledger proves GJC owns the current bridge directory and its entries. */
function ledgerOwnsBridge(ledger: ProvenanceLedger): boolean {
	return (
		ledger.bridgePath !== undefined &&
		((ledger.bridgeEntries?.length ?? 0) > 0 ||
			ledger.bridgeDirCreated === true ||
			ledger.bridgeCleanupPending !== undefined)
	);
}
/**
 * Correct the provenance ledger to what a FAILED bridge install actually
 * completed (#4644 review r9): the pre-write's planned ownership must not
 * stand as fact after a mid-operation failure, so ownership becomes the prior
 * recorded entries minus completed prunes plus created/adopted links.
 */
export async function correctBridgeOwnershipAfterFailure(
	deps: PaseoSetupDependencies,
	bridgeLedger: ProvenanceLedger,
	isMigration: boolean,
	partial: SkillsBridgeInstallResult,
): Promise<void> {
	const pruned = new Set(partial.prunedEntries);
	const actual = [
		...(isMigration ? [] : (bridgeLedger.bridgeEntries ?? []).filter(name => !pruned.has(name))),
		...partial.createdEntries,
		...partial.adoptedEntries,
	].filter((name, index, all) => all.indexOf(name) === index);
	const corrected = await readProvenance(deps.paths.provenanceLedger);
	const correctedPath =
		isMigration && (actual.length > 0 || partial.bridgeDirCreated) ? deps.paths.bridgeDir : corrected.bridgePath;
	const correctedLedger: ProvenanceLedger = {
		...corrected,
		...(correctedPath === undefined ? { bridgePath: undefined } : { bridgePath: correctedPath }),
		...(partial.sourceDir !== undefined ? { bridgeSourceDir: partial.sourceDir } : {}),
		bridgeEntries: actual,
		bridgeEntryIdentities: {
			...Object.fromEntries(
				Object.entries(bridgeLedger.bridgeEntryIdentities ?? {}).filter(([name]) => actual.includes(name)),
			),
			...partial.entryIdentities,
		},
		bridgeDirCreated: isMigration
			? partial.bridgeDirCreated
			: corrected.bridgeDirCreated === true || partial.bridgeDirCreated,
		...(partial.bridgeDirIdentity ? { bridgeDirIdentity: partial.bridgeDirIdentity } : {}),
	};
	const intent = await readIntent(deps.paths.intentRecord);
	if (intent?.step === "skills-bridge" && intent.provenancePath === deps.paths.provenanceLedger) {
		await writeIntent(deps.paths.intentRecord, {
			...intent,
			provenanceExpectedIdentity: provenanceLedgerIdentity(correctedLedger),
			provenancePayload: correctedLedger,
		});
	}
	await writeProvenance(deps.paths.provenanceLedger, correctedLedger);
}
/** The RAW value a Paseo config carries at `agents.providers.<key>`, of any shape. */
function readRawProviderValue(config: Record<string, unknown>, providerKey: string): unknown {
	const agents = config.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	return (providers as Record<string, unknown>)[providerKey];
}

/**
 * Undo a provider write exactly: a key this run created is removed, and a key
 * that carried ANY prior value (object, scalar, array, or null) gets that
 * value back instead of being deleted.
 */
function restoreProviderKey(draft: Record<string, unknown>, providerKey: string, replacedEntry: unknown): void {
	const agents = draft.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
	if (replacedEntry === undefined) delete (providers as Record<string, unknown>)[providerKey];
	else (providers as Record<string, unknown>)[providerKey] = replacedEntry;
}

async function unregisterBridgeDirectory(settings: Settings, bridgeDir: string): Promise<void> {
	await settings.commitAtomicBatchWithCurrent(async current => {
		const skills = current.skills;
		if (!skills || typeof skills !== "object" || Array.isArray(skills)) return [];
		const directories = (skills as Record<string, unknown>).customDirectories;
		if (!Array.isArray(directories)) return [];
		const canonicalBridge = await canonicalPathForComparison(bridgeDir);
		const canonicalDirectories = await Promise.all(
			directories.map(directory => canonicalPathForComparison(directory)),
		);
		const next = directories.filter((_directory, index) => canonicalDirectories[index] !== canonicalBridge);
		if (next.length === directories.length) return [];
		return [{ path: "skills.customDirectories", op: "set", value: next }];
	});
}
