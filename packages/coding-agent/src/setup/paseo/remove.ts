/**
 * Provenance-gated rollback for `gjc setup paseo --remove`.
 *
 * Removal never deletes on value-equality alone. A key is removed only when
 * GJC's own ledger recorded creating it AND the current value still hashes to
 * what GJC wrote. A user who hand-authored the same value, or who edited ours
 * afterwards, keeps their content.
 *
 * Steps are undone in reverse of the install order (4 to 1). The first step
 * that cannot be undone safely halts the rest, so the result is an
 * interpretable prefix rather than a scattered mix.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	currentIdentity,
	PaseoPublishError,
	planPublish,
	publishPlan,
	readReplacedProviderBackup,
	readTarget,
	removeReplacedProviderBackup,
	removeSourceClaim,
	replacedProviderBackupPath,
	type SourceClaimReceipt,
} from "./json-publisher";
import { removeSeededRoles } from "./orchestration-preferences";
import {
	type BridgeCleanupAuthority,
	clearIntent,
	EMPTY_LEDGER,
	INTENT_VERSION,
	type IntentRecord,
	isProvenancedOrchestrationKey,
	isProvenancedProvider,
	type ProvenanceLedger,
	type ProviderReplacedRef,
	provenancedProviderKeys,
	readIntent,
	readProvenance,
	writeIntent,
	writeProvenance,
} from "./paseo-ownership";
import { type PaseoProviderEntry, providerEntryHash } from "./provider-config";
import type { PartialRemovalEvidence, PaseoRemoveResult } from "./result-types";
import { isTrustedRecordedSkillsSource, type PaseoSetupDependencies } from "./setup-deps";
import { inverseSkillsBridge, legacySourceDirFor, replayBridgeCleanup, SkillsBridgeError } from "./skills-bridge";

export interface RemoveOptions {
	readonly now: Date;
	/** Undo the config.yml `skills.customDirectories` append. Supplied by the orchestrator. */
	readonly unregisterBridgeDirectory?: () => Promise<void>;
}
/**
 * `lstat` distinguishing a genuinely absent path from a filesystem failure.
 *
 * A permission or I/O error on the bridge directory must NOT be collapsed into
 * "absent": treating it as absence clears all bridge provenance and reports a
 * successful removal while an owned link is still on disk. Only `ENOENT` counts
 * as absent; every other error propagates and fails the removal closed.
 */
async function lstatAllowingAbsent(destination: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Prove an agent directory carries GJC's own `paseo` ledger shape: a real
 * non-symlink `paseo` directory that itself contains a `provenance.json`
 * regular file. `stat` follows symlinks, so a bare directory-name match (or a
 * symlink named `paseo`) is not evidence — a forged path inside the bridge
 * directory replicates the name but never the full ledger shape.
 */
async function isGenuinePaseoLedgerDir(agentDir: string): Promise<boolean> {
	const ledgerDir = path.join(agentDir, "paseo");
	try {
		const stat = await fs.lstat(ledgerDir);
		if (!stat.isDirectory()) return false;
		const ledger = await fs.lstat(path.join(ledgerDir, "provenance.json"));
		return ledger.isFile();
	} catch {
		return false;
	}
}
/**
 * The migration directory's own ledger must claim the exact recorded bridge
 * directory (#4644 review r14): the victim's `paseo/provenance.json` must
 * record `bridgePath` equal to the path being validated. Fabricating names
 * beside an arbitrary directory is trivial; making a victim directory hold a
 * GJC ledger that already claims this exact bridge is a genuine prior
 * installation.
 */
async function readsRecordedBridgeDir(oldAgentDir: string, recordedBridgeDir: string): Promise<boolean> {
	try {
		const ledgerPath = path.join(oldAgentDir, "paseo", "provenance.json");
		const ledger = await readProvenance(ledgerPath);
		return ledger.bridgePath !== undefined && path.resolve(ledger.bridgePath) === path.resolve(recordedBridgeDir);
	} catch {
		return false;
	}
}

function sameBridgeEntryIdentity(
	recorded: NonNullable<ProvenanceLedger["bridgeEntryIdentities"]>[string] | undefined,
	observed: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint },
): boolean {
	return (
		recorded !== undefined &&
		recorded.dev === observed.dev.toString() &&
		recorded.ino === observed.ino.toString() &&
		recorded.size === observed.size.toString() &&
		recorded.mtimeNs === observed.mtimeNs.toString()
	);
}
/**
 * Whether a directory actually holds the bridge the ledger describes: every
 * PRESENT recorded entry must be a symlink pointing into the ledger's
 * recorded source (#4644 review r19). An empty bridge has no link target to
 * inspect, so its recorded creator bit and directory identity authenticate the
 * object instead. This is the content authentication that distinguishes a
 * genuine migration (the old bridge with GJC's links) from a tampered ledger
 * aiming at an in-root sibling holding foreign content.
 */
async function directoryHoldsRecordedBridge(ledger: ProvenanceLedger, dir: string): Promise<boolean> {
	const entries = ledger.bridgeEntries ?? [];
	if (entries.length === 0) {
		// An empty bridge has no link targets to authenticate. The only durable
		// ownership proof is that GJC recorded creating this directory and its
		// no-follow object identity still matches the live directory. This keeps
		// an empty path migration eligible without allowing a replacement
		// directory to inherit the old registration or cleanup authority.
		const recorded = ledger.bridgeDirIdentity;
		if (ledger.bridgeDirCreated !== true || recorded === undefined) return false;
		const stat = await fs.lstat(dir, { bigint: true }).catch(() => undefined);
		if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return false;
		return stat.dev.toString() === recorded.dev && stat.ino.toString() === recorded.ino;
	}
	const sourceDir = ledger.bridgeSourceDir;
	if (sourceDir === undefined) return false;
	let present = 0;
	for (const name of entries) {
		if (path.basename(name) !== name) return false;
		const entryPath = path.join(dir, name);
		const stat = await fs.lstat(entryPath, { bigint: true }).catch(() => undefined);
		if (stat === undefined) continue; // absent entries are consistent with a migration
		present += 1;
		if (!stat.isSymbolicLink()) return false;
		const text = await fs.readlink(entryPath).catch(() => undefined);
		if (text === undefined) return false;
		if (path.resolve(path.dirname(entryPath), text) !== path.resolve(sourceDir, name)) return false;
		// Link text authenticates the intended target, not the object at the
		// pathname. A user-created replacement can carry identical text, so a
		// migration root is genuine only when every present recorded link also
		// matches the no-follow identity GJC persisted at install time.
		if (
			!sameBridgeEntryIdentity(ledger.bridgeEntryIdentities?.[name], {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
			})
		) {
			return false;
		}
	}
	// A directory holding NONE of the recorded links is not the described
	// bridge, whatever the ledger claims about it.
	return present > 0;
}

/**
 * The ledger-recorded bridge directory, validated before any destructive use.
 *
 * A malformed, tampered, or path-replaced provenance record must never
 * redirect cleanup at an unrelated directory. Two shapes are accepted:
 *
 * - the recorded path lives inside the agent directory the ledger itself lives
 *   in (the parent of the ledger's `paseo/` directory) — the ordinary case; or
 * - it is a GENUINE migration record: absolute, canonically spelled, carrying
 *   the exact bridge basename, whose parent directory also holds the `paseo`
 *   ledger directory (the recorded agent-dir shape GJC itself wrote).
 *
 * Both require the path to resolve — without following a final symlink — to a
 * directory, and the fully RESOLVED location must satisfy the same two shapes:
 * `lstat` inspects only the final component, so a symlinked ancestor could
 * otherwise carry a lexically-accepted record somewhere else entirely.
 * Anything else fails the removal closed.
 */
export async function validatedBridgeDir(ledger: ProvenanceLedger, deps: PaseoSetupDependencies): Promise<string> {
	const recorded = ledger.bridgePath ?? deps.paths.bridgeDir;
	const trustedRoot = path.resolve(path.dirname(deps.paths.provenanceLedger), "..");
	const resolved = path.resolve(recorded);
	if (!path.isAbsolute(recorded) || resolved !== recorded) {
		throw new SkillsBridgeError(
			`Refusing to remove Paseo skills bridge: ledger-recorded path is not absolute (${recorded})`,
		);
	}
	const bridgeBasename = path.basename(path.resolve(deps.paths.bridgeDir));
	const withinTrustedRoot =
		resolved === path.resolve(trustedRoot) || resolved.startsWith(`${path.resolve(trustedRoot)}${path.sep}`);
	// #4644 review r19: an in-root record is accepted ONLY when it is the
	// CURRENT configured bridge path (the ordinary case — the ledger records
	// the bridge GJC itself created for this dependency set). Any OTHER
	// in-root directory, however bridge-shaped its basename, is not
	// automatically trusted: a tampered ledger could aim cleanup at a foreign
	// `*-paseo-skills` sibling. A different path must qualify as a GENUINE
	// migration record (authenticated by the OLD directory's own ledger,
	// below) even when it happens to sit inside this agent root.
	const isCurrentBridge = resolved === path.resolve(deps.paths.bridgeDir);
	const isBridgeBasename = (candidate: string): boolean =>
		candidate === bridgeBasename || candidate === "paseo-skills" || candidate.endsWith("-paseo-skills");
	if (!isBridgeBasename(path.basename(resolved))) {
		throw new SkillsBridgeError(
			`Refusing to remove Paseo skills bridge: ledger-recorded path does not carry the bridge directory name (${recorded}); expected .../${bridgeBasename}`,
		);
	}
	const oldAgentDir = path.dirname(resolved);
	// A migration record is authenticated by the OLD directory's own ledger
	// AND by its CONTENT (#4644 review r19): a same-ledger claim on an in-root
	// sibling is self-referential, so the recorded directory must actually
	// hold the bridge links the ledger describes — every present recorded
	// entry a symlink pointing into the ledger's recorded source. An owned empty
	// bridge has no link target, so that shape requires its recorded directory
	// identity instead of accepting a foreign ledger alone. A foreign sibling
	// with user content fails that check regardless of what a tampered ledger
	// claims.
	const holdsDescribedBridge = await directoryHoldsRecordedBridge(ledger, resolved);
	const genuineMigration =
		!isCurrentBridge &&
		// A victim ledger claim is not enough: every present non-empty link must
		// also match its recorded no-follow identity. This closes the same-target
		// replacement case even when a separate old-agent ledger claims the path.
		holdsDescribedBridge &&
		isBridgeBasename(path.basename(resolved)) &&
		(await isGenuinePaseoLedgerDir(oldAgentDir)) &&
		(await readsRecordedBridgeDir(oldAgentDir, resolved));
	if (!isCurrentBridge && !genuineMigration) {
		throw new SkillsBridgeError(
			`Refusing to remove Paseo skills bridge: ledger-recorded path is neither the configured bridge (${deps.paths.bridgeDir}) nor an authenticated migration record (${recorded})`,
		);
	}
	// Out-of-root records still need the genuine-migration authentication
	// (#4644 reviews r14/r19): the OLD directory must carry a GJC ledger that
	// itself claims this exact bridge path.
	if (!withinTrustedRoot && !genuineMigration) {
		throw new SkillsBridgeError(
			`Refusing to remove Paseo skills bridge: ledger-recorded path escapes the agent directory (${recorded})`,
		);
	}
	try {
		const stat = await fs.lstat(recorded);
		if (stat.isSymbolicLink()) {
			throw new SkillsBridgeError(
				`Refusing to remove Paseo skills bridge: ledger-recorded path is a symlink (${recorded})`,
			);
		}
		if (!stat.isDirectory()) {
			throw new SkillsBridgeError(
				`Refusing to remove Paseo skills bridge: ledger-recorded path is not a directory (${recorded})`,
			);
		}
	} catch (error) {
		if (error instanceof SkillsBridgeError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// The recorded directory is gone, but a persisted `.removing` sibling may
			// still be the exact replay authority. Canonicalize the surviving parent so
			// replay below does not compare a lexical symlink-ancestor path with the
			// native canonical authority.
			const canonicalParent = await fs.realpath(path.dirname(recorded));
			return path.join(canonicalParent, path.basename(recorded));
		}
		throw error;
	}
	// A canonically spelled, non-symlink record can still travel through a
	// symlinked ANCESTOR: `lstat` above inspects only the final component. The
	// fully resolved location must satisfy the same two accepted shapes, so a
	// record that merely looks safe lexically cannot steer cleanup outside the
	// agent root. `realpath` failures (EACCES and friends) propagate and fail
	// the removal closed.
	const real = await fs.realpath(recorded);
	const realRoot = await fs.realpath(trustedRoot);
	const realWithinTrustedRoot = real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
	const realMigrationShape =
		path.basename(real) === bridgeBasename &&
		(await isGenuinePaseoLedgerDir(path.dirname(real))) &&
		(await readsRecordedBridgeDir(path.dirname(real), real));
	if (!realWithinTrustedRoot && !realMigrationShape) {
		throw new SkillsBridgeError(
			`Refusing to remove Paseo skills bridge: ledger-recorded path resolves outside the agent directory (${recorded})`,
		);
	}
	return real;
}

async function canonicalCleanupAuthority(
	authority: NonNullable<ProvenanceLedger["bridgeCleanupPending"]>,
): Promise<NonNullable<ProvenanceLedger["bridgeCleanupPending"]>> {
	const parent = await fs.realpath(path.dirname(authority.originalPath));
	const originalPath = path.join(parent, path.basename(authority.originalPath));
	return { ...authority, originalPath, detachedPath: `${originalPath}.removing` };
}
/**
 * Ledger entry names that are safe to compose cleanup paths from.
 *
 * Every recorded entry must be a single plain basename. A tampered ledger can
 * carry `../`-style traversal or path separators; such a name is never handed
 * to a path join, it is reported as a refusal instead.
 */
export function safeBridgeEntryNames(entries: readonly string[]): readonly string[] {
	for (const name of entries) {
		if (path.basename(name) !== name || name.includes("/") || name === "." || name === "..") {
			throw new SkillsBridgeError(
				`Refusing to remove Paseo skills bridge entry with an unsafe recorded name (${name}); restore or delete the provenance ledger after confirming no Paseo bridge links are live`,
			);
		}
	}
	return entries;
}

/**
 * Remove every target GJC can prove it owns.
 *
 * Returns `nothing-to-remove` when the ledger holds no ownership at all, which
 * is distinct from removing zero keys because the user edited all of them.
 */
export async function removePaseoSetup(
	deps: PaseoSetupDependencies,
	options: RemoveOptions,
): Promise<PaseoRemoveResult> {
	const ledger = await readProvenance(deps.paths.provenanceLedger);
	const ownsAnything =
		provenancedProviderKeys(ledger).length > 0 ||
		Object.keys(ledger.providerReplacedEntries ?? {}).length > 0 ||
		Object.keys(ledger.seededOrchestrationKeys).length > 0 ||
		(ledger.bridgeEntries?.length ?? 0) > 0 ||
		ledger.bridgeCleanupPending !== undefined ||
		// An owned empty bridge is still GJC-owned state: a convergence run that
		// pruned the final entry leaves `bridgeEntries: []` with
		// `bridgeDirCreated: true`, and the directory plus its registration must
		// still be removable.
		ledger.bridgeDirCreated === true;
	if (!ownsAnything) return { outcome: "nothing-to-remove" };

	const removed: string[] = [];
	const remaining: string[] = [];
	let nextLedger = ledger;
	// A pre-#4638 ledger has no recorded source directory. Keep removal's
	// omitted-resolver fallback in lockstep with install/check: an explicitly
	// supplied legacy `paths.agentsSkillsDir` wins over deriving the path from
	// `home`. Only that exact caller fallback gets the additional trust seam;
	// recorded sources still use the production rule (or an explicit test hook).
	const callerLegacySourceFallback =
		ledger.bridgeSourceDir === undefined &&
		deps.skillsSource === undefined &&
		deps.paths.agentsSkillsDir !== undefined;
	const legacySourceDir = callerLegacySourceFallback ? deps.paths.agentsSkillsDir : legacySourceDirFor(deps);

	// The recorded bridge path is validated BEFORE any settings mutation: a
	// malformed or tampered ledger must never steer `skills.customDirectories`
	// unregistering (or the symlink cleanup below) at a foreign path.
	let validatedBridge: string | undefined;
	if (ledger.bridgePath !== undefined || ledger.bridgeDirCreated === true) {
		try {
			validatedBridge = await validatedBridgeDir(ledger, deps);
		} catch (error) {
			const detail = error instanceof SkillsBridgeError ? error.message : String(error);
			return partial([], [ledger.bridgePath ?? deps.paths.bridgeDir], {
				failedStep: "provenance ledger validation",
				detail,
				retained: [deps.paths.provenanceLedger],
			});
		}
	}
	// The recorded bridge SOURCE is validated in the same pre-settings window
	// (#4644 review r10, architect gen-5): it drives link-text verification at
	// unlink time, so a tampered source must refuse BEFORE the
	// `skills.customDirectories` registration is unregistered — mirroring the
	// bridge-path rule directly above.
	if (ledger.bridgeEntries?.length || ledger.bridgeDirCreated === true) {
		const sourceDir = ledger.bridgeSourceDir ?? legacySourceDir;
		const sourceTrust =
			deps.trustedSkillsSource !== undefined
				? await deps.trustedSkillsSource(sourceDir)
				: callerLegacySourceFallback && path.isAbsolute(sourceDir)
					? { ok: true as const }
					: await isTrustedRecordedSkillsSource(sourceDir);
		if (!sourceTrust.ok) {
			return partial([], [ledger.bridgePath ?? deps.paths.bridgeDir], {
				failedStep: "provenance ledger validation",
				detail: sourceTrust.detail,
				retained: [deps.paths.provenanceLedger],
			});
		}
	}
	// A POSIX native tree removal first detaches the empty bridge to the exact
	// `<bridge>.removing` sibling and returns `cleanup_pending`. Replay that
	// authority before touching settings or clearing any bridge provenance. The
	// detached path is persisted before the first native call, so this also
	// settles a process crash between namespace detach and the final cleanup.
	if (ledger.bridgeCleanupPending !== undefined) {
		const authority = await canonicalCleanupAuthority(ledger.bridgeCleanupPending);
		if (
			validatedBridge === undefined ||
			path.resolve(authority.originalPath) !== validatedBridge ||
			path.resolve(`${validatedBridge}.removing`) !== path.resolve(authority.detachedPath)
		) {
			remaining.push(authority.detachedPath);
			return partial([], remaining, {
				failedStep: "provenance ledger validation",
				detail: `the persisted Paseo bridge cleanup authority does not match the recorded bridge path (${authority.detachedPath})`,
				retained: [deps.paths.provenanceLedger, authority.detachedPath],
			});
		}
		try {
			await replayBridgeCleanup(authority);
			nextLedger = { ...nextLedger, bridgeCleanupPending: undefined };
		} catch (error) {
			remaining.push(authority.detachedPath);
			return partial([], remaining, {
				failedStep: authority.detachedPath,
				detail: error instanceof Error ? error.message : String(error),
				retained: [deps.paths.provenanceLedger, authority.detachedPath],
			});
		}
	}

	// Step 4 inverse: config.yml registration.
	if (options.unregisterBridgeDirectory) {
		try {
			await options.unregisterBridgeDirectory();
			removed.push("config.yml skills.customDirectories");
		} catch (error) {
			return partial(removed, ["config.yml skills.customDirectories"], {
				failedStep: "config.yml skills.customDirectories",
				detail: error instanceof Error ? error.message : String(error),
				retained: [deps.paths.provenanceLedger],
			});
		}
	}

	// Step 3 inverse: the symlink bridge. Runs when entries are recorded OR
	// when GJC created the directory itself -- a convergence run that pruned
	// the final entry leaves `bridgeEntries: []` with `bridgeDirCreated: true`,
	// and the empty directory GJC created is still ours to remove.
	if ((ledger.bridgeEntries?.length ?? 0) > 0 || ledger.bridgeDirCreated === true) {
		try {
			// The ledger once filtered entries through a compiled-in name
			// allowlist; ownership is now proven by the entry itself being a
			// symlink that still resolves into the source directory the ledger
			// recorded when the link was created. A name Paseo no longer ships
			// is still removed, because the record -- not today's source
			// contents -- is what proves GJC created it.
			// Validated above, before any settings mutation, so the cleanup paths
			// and the registration unregistering provably describe the same
			// ledger-owned directory.
			const bridgeDir = validatedBridge ?? deps.paths.bridgeDir;
			// Every present recorded pathname is preserved for inverse
			// validation: an entry replaced by a regular file or directory is
			// handed to the inverse, which reports it as a divergence instead of
			// being silently skipped and reported as success.
			const presentEntries: string[] = [];
			const ambiguousEntries: string[] = [];
			for (const name of safeBridgeEntryNames(ledger.bridgeEntries ?? [])) {
				const destination = path.join(bridgeDir, name);
				const stat = await lstatAllowingAbsent(destination);
				if (stat === undefined) continue;
				// A recorded name without an install-time identity is only a plan or
				// legacy evidence, never destructive authority. Preserve the live
				// pathname and its ledger evidence while independently owned links and
				// JSON state continue through removal.
				if (ledger.bridgeEntryIdentities?.[name] === undefined) {
					ambiguousEntries.push(name);
					continue;
				}
				presentEntries.push(name);
			}
			// A recorded source directory is trusted even after it disappears
			// (Paseo uninstalled): link-text verification does not need it on
			// disk, and the links are inside GJC's own bridge directory. A
			// legacy ledger that predates `bridgeSourceDir` falls back to the
			// single location a pre-#4638 install could have linked from, so a
			// machine wedged by #4638 can still be rolled back.
			const sourceDir = ledger.bridgeSourceDir ?? legacySourceDir;
			// The recorded source was validated in the pre-settings window
			// above (#4644 review r10), exactly like the bridge path.
			await inverseSkillsBridge(
				deps,
				{
					createdEntries: presentEntries,
					prunedEntries: [],
					adoptedEntries: [],
					entryIdentities: ledger.bridgeEntryIdentities ?? {},
					// An ambiguous live entry keeps the directory user-relevant; never
					// remove the directory around it even when the ledger says GJC
					// created the directory originally.
					bridgeDirCreated: ambiguousEntries.length === 0 && (ledger.bridgeDirCreated ?? false),
					bridgeDirIdentity: ledger.bridgeDirIdentity,
					sourceDir,
				},
				// Unlink, directory cleanup, and diagnostics all operate on the
				// ledger-recorded directory the entries above were validated in.
				{
					bridgeDir,
					onCleanupPending: async (authority: BridgeCleanupAuthority) => {
						nextLedger = { ...nextLedger, bridgeCleanupPending: authority };
						// Persist BEFORE native detaches the directory. If the process dies
						// after the rename, the next remove replays this exact sibling.
						await writeProvenance(deps.paths.provenanceLedger, nextLedger);
					},
				},
			);
			if (presentEntries.length > 0 || (ambiguousEntries.length === 0 && ledger.bridgeDirCreated === true)) {
				removed.push(bridgeDir);
			}
			if (ambiguousEntries.length === 0) {
				nextLedger = {
					...nextLedger,
					bridgeEntries: [],
					bridgeEntryIdentities: {},
					bridgeDirCreated: false,
					bridgeSourceDir: undefined,
					bridgeCleanupPending: undefined,
				};
			} else {
				const ambiguous = new Set(ambiguousEntries);
				const retainedIdentities = Object.fromEntries(
					Object.entries(nextLedger.bridgeEntryIdentities ?? {}).filter(([name]) => ambiguous.has(name)),
				);
				nextLedger = {
					...nextLedger,
					bridgeEntries: (nextLedger.bridgeEntries ?? []).filter(name => ambiguous.has(name)),
					...(nextLedger.bridgeEntryIdentities !== undefined ? { bridgeEntryIdentities: retainedIdentities } : {}),
				};
				remaining.push(bridgeDir);
			}
		} catch (error) {
			const detail = error instanceof SkillsBridgeError ? error.message : String(error);
			const retained = error instanceof SkillsBridgeError ? error.retained : [];
			remaining.push(ledger.bridgePath ?? deps.paths.bridgeDir);
			remaining.push(...retained);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: ledger.bridgePath ?? deps.paths.bridgeDir,
				detail,
				retained: [deps.paths.provenanceLedger, ...retained],
			});
		}
	}

	// Step 2 inverse: seeded orchestration roles.
	const seededKeys = Object.keys(nextLedger.seededOrchestrationKeys);
	if (seededKeys.length > 0) {
		// Roles live under `providers`, so removal must reach into that map. Deleting
		// a top-level key would clear our provenance while leaving the role pointing
		// at the provider entry we are about to delete.
		const outcome = await revertJson(
			deps.paths.orchestrationPreferences,
			options.now,
			"orchestration-preferences",
			seededKeys,
			deps.paths.intentRecord,
			deps.paths.provenanceLedger,
			draft =>
				removeSeededRoles(draft, seededKeys, (key, currentValue) =>
					isProvenancedOrchestrationKey(nextLedger, key, currentValue ?? ""),
				),
		);
		if (!outcome.ok) {
			remaining.push(deps.paths.orchestrationPreferences, ...outcome.retained);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: deps.paths.orchestrationPreferences,
				detail: outcome.detail,
				retained: [deps.paths.provenanceLedger, ...outcome.retained],
			});
		}
		removed.push(deps.paths.orchestrationPreferences);
		nextLedger = { ...nextLedger, seededOrchestrationKeys: {} };
	}

	// Step 1 inverse: provider entries, including every earlier `--mpreset` run.
	//
	// A `--force` overwrite recorded the entry it replaced; removal restores
	// that entry instead of deleting the key, because the replaced content was
	// never GJC's to take. Keys marked pre-existing (a matching entry that
	// existed before any GJC run) are not in providerKeys and are untouched.
	const providerKeys = [
		...new Set([...provenancedProviderKeys(nextLedger), ...Object.keys(nextLedger.providerReplacedEntries ?? {})]),
	].sort();
	if (providerKeys.length > 0) {
		const survivors: Record<string, string> = {};
		// A `--force` overwrite preserved the replaced value in a private sidecar
		// beside Paseo's own config; the ledger carries only the pointer, so the
		// value is loaded here, before the mutation. Restore values are read ONLY
		// for keys this removal will actually touch: an unreadable sidecar for a
		// key that survives (the user edited ours) would otherwise block removal
		// without any restore being needed. A missing or corrupt sidecar for a
		// key that IS restored fails the removal closed instead of deleting the
		// user content it was meant to bring back.
		const restores = new Map<string, unknown>();
		const configNow = await readTarget(deps.paths.configJson).catch(() => undefined);
		if (configNow?.parsed !== undefined) {
			const providersNow = providersOf(configNow.parsed);
			for (const key of providerKeys) {
				const entry = providersNow?.[key];
				if (entry === undefined) continue;
				if (!isProvenancedProvider(nextLedger, key, providerEntryHash(entry as PaseoProviderEntry))) continue;
				const ref = nextLedger.providerReplacedEntries?.[key];
				if (ref === undefined) continue;
				// The recorded pointer must name the deterministic sidecar GJC
				// itself derives from THIS config path and key. A tampered ledger
				// pointing elsewhere would otherwise read an arbitrary JSON file
				// into agents.providers and delete it after the "restore" — the
				// exact asymmetry the bridge path and entry names already close.
				if (ref.backupPath !== replacedProviderBackupPath(deps.paths.configJson, key)) {
					remaining.push(deps.paths.configJson);
					await writeProvenance(deps.paths.provenanceLedger, nextLedger);
					return partial(removed, remaining, {
						failedStep: deps.paths.configJson,
						detail: `the replaced-provider backup for ${key} is recorded at an unexpected path (${ref.backupPath}); refusing to restore or delete it`,
						retained: [deps.paths.provenanceLedger],
					});
				}
				const backup = await readReplacedProviderBackup(ref.backupPath, key, ref.valueSha256, ref.identity);
				if (!backup.found) {
					remaining.push(deps.paths.configJson);
					await writeProvenance(deps.paths.provenanceLedger, nextLedger);
					return partial(removed, remaining, {
						failedStep: deps.paths.configJson,
						detail: `the replaced provider entry for ${key} cannot be restored: its backup is missing or unreadable (${ref.backupPath}); restore it before removing`,
						retained: [deps.paths.provenanceLedger],
					});
				}
				restores.set(key, backup.value);
			}
		}
		const pendingSidecarKeys = new Set<string>();
		const restoredContinuations = new Set<string>();
		const providersBefore = providersOf(configNow?.parsed ?? {});
		// A prior removal may have restored the user's value successfully but
		// failed while deleting its authenticated sidecar. On retry the value no
		// longer hashes as GJC-owned, so recognize the exact sidecar value as a
		// cleanup continuation rather than treating it as an unrelated edit.
		for (const [key, ref] of Object.entries(nextLedger.providerReplacedEntries ?? {})) {
			const entry = providersBefore?.[key];
			if (entry === undefined) continue;
			if (isProvenancedProvider(nextLedger, key, providerEntryHash(entry as PaseoProviderEntry))) continue;
			if (ref.backupPath !== replacedProviderBackupPath(deps.paths.configJson, key)) {
				remaining.push(deps.paths.configJson);
				await writeProvenance(deps.paths.provenanceLedger, nextLedger);
				return partial(removed, remaining, {
					failedStep: deps.paths.configJson,
					detail: `the replaced-provider backup for ${key} is recorded at an unexpected path (${ref.backupPath}); refusing to authenticate pending cleanup`,
					retained: [deps.paths.provenanceLedger],
				});
			}
			const backup = await readReplacedProviderBackup(ref.backupPath, key, ref.valueSha256, ref.identity);
			if (backup.found && JSON.stringify(entry) === JSON.stringify(backup.value)) {
				restoredContinuations.add(key);
			} else {
				pendingSidecarKeys.add(key);
			}
		}
		const revertedOrdinaryKeys = new Set<string>();
		const outcome = await revertJson(
			deps.paths.configJson,
			options.now,
			"provider-config",
			providerKeys,
			deps.paths.intentRecord,
			deps.paths.provenanceLedger,
			draft => {
				const providers = providersOf(draft);
				if (!providers) return;
				for (const key of providerKeys) {
					const entry = providers[key];
					if (entry === undefined) continue;
					const hash = providerEntryHash(entry as PaseoProviderEntry);
					if (!isProvenancedProvider(nextLedger, key, hash)) {
						if (restoredContinuations.has(key)) continue;
						survivors[key] = nextLedger.providerKeys[key] ?? hash;
						continue;
					}
					const replaced = restores.get(key);
					if (replaced !== undefined) providers[key] = replaced;
					else {
						delete providers[key];
						revertedOrdinaryKeys.add(key);
					}
				}
			},
		);
		if (!outcome.ok) {
			remaining.push(deps.paths.configJson, ...outcome.retained);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: deps.paths.configJson,
				detail: outcome.detail,
				retained: [deps.paths.provenanceLedger, ...outcome.retained],
			});
		}
		// The restored values are back in Paseo's config; the sidecars that held
		// them have served their purpose and must not outlive the ownership they
		// recorded. Deletion failures and leftovers fail the removal closed
		// (#4644 review r11): dropping the ledger reference while a
		// credential-bearing sidecar still exists would orphan it with nothing
		// pointing at it, and swallowing the unlink error would hide exactly
		// that. Keys whose GJC entry is already absent from the config still
		// have their sidecar removed here -- the entry GJC replaced is gone
		// along with ours, so the preserved value is unreachable either way and
		// keeping the sidecar would strand a credential file nothing references.
		const orphaned: string[] = [];
		const relevantRefs: { readonly key: string; readonly ref: ProviderReplacedRef }[] = [];
		const providersAfter = providersOf(
			(await readTarget(deps.paths.configJson).catch(() => undefined))?.parsed ?? {},
		);
		for (const [key, ref] of Object.entries(nextLedger.providerReplacedEntries ?? {})) {
			if (survivors[key] !== undefined) continue;
			if (restores.has(key) || restoredContinuations.has(key) || providersAfter?.[key] === undefined) {
				// EVERY reference is validated against the deterministic sidecar
				// path GJC itself derives (#4644 review r16) — the same rule the
				// restore loop applies — before any deletion: a tampered ledger
				// must not redirect `fs.rm` at an arbitrary absolute file.
				if (ref.backupPath !== replacedProviderBackupPath(deps.paths.configJson, key)) {
					remaining.push(deps.paths.configJson);
					await writeProvenance(deps.paths.provenanceLedger, nextLedger);
					return partial(removed, remaining, {
						failedStep: deps.paths.configJson,
						detail: `the replaced-provider backup for ${key} is recorded at an unexpected path (${ref.backupPath}); refusing to delete it`,
						retained: [deps.paths.provenanceLedger],
					});
				}
				relevantRefs.push({ key, ref });
			} else {
				pendingSidecarKeys.add(key);
			}
		}
		const cleanedKeys = new Set<string>();
		for (const { key, ref: providerRef } of relevantRefs) {
			if (providerRef.createdByGjc === false) {
				// An exact sidecar that predated this install remains user-owned even
				// after it restored the replaced value; clear only GJC's ledger pointer.
				cleanedKeys.add(key);
				continue;
			}
			// Authenticate and delete under one inode-bound protocol. A pathname
			// replacement after authentication is retained, never removed.
			if (
				providerRef.identity !== undefined &&
				(await removeReplacedProviderBackup(
					providerRef.backupPath,
					key,
					providerRef.valueSha256,
					providerRef.identity,
				))
			) {
				cleanedKeys.add(key);
			} else {
				orphaned.push(providerRef.backupPath);
			}
		}
		const keptRefs: Record<string, ProviderReplacedRef> = { ...(nextLedger.providerReplacedEntries ?? {}) };
		const keptProviderKeys: Record<string, string> = { ...nextLedger.providerKeys };
		for (const key of [...cleanedKeys, ...revertedOrdinaryKeys]) {
			delete keptRefs[key];
			delete keptProviderKeys[key];
		}
		nextLedger = { ...nextLedger, providerKeys: keptProviderKeys, providerReplacedEntries: keptRefs };
		if (orphaned.length > 0) {
			remaining.push(deps.paths.configJson);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: deps.paths.configJson,
				detail: `a replaced-provider backup could not be removed (${orphaned.join(", ")}); remove it before re-running so no credential-bearing sidecar is left unreferenced`,
				retained: [deps.paths.provenanceLedger],
			});
		}
		if (pendingSidecarKeys.size > 0) {
			remaining.push(deps.paths.configJson);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: deps.paths.configJson,
				detail: `replaced-provider sidecar cleanup remains pending for ${[...pendingSidecarKeys].join(", ")}; the preserved value or sidecar changed, so GJC will not clear its reference`,
				retained: [deps.paths.provenanceLedger, ...Object.values(keptRefs).map(ref => ref.backupPath)],
			});
		}
		removed.push(deps.paths.configJson);
		nextLedger = {
			...nextLedger,
			providerKeys: { ...survivors, ...keptProviderKeys },
			providerReplacedEntries: keptRefs,
		};
	}

	const stillOwns =
		Object.keys(nextLedger.providerKeys).length > 0 ||
		Object.keys(nextLedger.providerReplacedEntries ?? {}).length > 0 ||
		Object.keys(nextLedger.seededOrchestrationKeys).length > 0 ||
		(nextLedger.bridgeEntries?.length ?? 0) > 0 ||
		nextLedger.bridgeCleanupPending !== undefined ||
		nextLedger.bridgeDirCreated === true;
	await writeProvenance(deps.paths.provenanceLedger, stillOwns ? nextLedger : EMPTY_LEDGER);
	if (remaining.length > 0) {
		return partial(removed, remaining, {
			failedStep: remaining.includes(ledger.bridgePath ?? deps.paths.bridgeDir)
				? (ledger.bridgePath ?? deps.paths.bridgeDir)
				: remaining[0]!,
			detail: `preserved identityless Paseo bridge entries: ${remaining.includes(ledger.bridgePath ?? deps.paths.bridgeDir) ? (ledger.bridgeEntries ?? []).filter(name => ledger.bridgeEntryIdentities?.[name] === undefined).join(", ") : remaining.join(", ")}`,
			retained: [deps.paths.provenanceLedger, ...remaining],
		});
	}
	return { outcome: "removed", removed };
}

function providersOf(draft: Record<string, unknown>): Record<string, unknown> | undefined {
	const agents = draft.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	return providers as Record<string, unknown>;
}

async function revertJson(
	targetPath: string,
	now: Date,
	step: "provider-config" | "orchestration-preferences",
	ownedKeys: readonly string[],
	intentPath: string,
	provenancePath: string,
	mutate: (draft: Record<string, unknown>) => void,
): Promise<{ ok: true } | { ok: false; detail: string; retained: readonly string[] }> {
	let sourceClaim: (SourceClaimReceipt & { readonly targetPath: string }) | undefined;
	let ownsIntent = false;
	try {
		const current = await readTarget(targetPath);
		if (!current.exists) return { ok: true };
		const plan = planPublish(current, mutate);
		const existingIntent = await readIntent(intentPath);
		if (
			existingIntent !== undefined &&
			(path.resolve(existingIntent.provenancePath) !== path.resolve(provenancePath) ||
				existingIntent.step !== "skills-bridge")
		) {
			return {
				ok: false,
				detail: `another durable intent is already recorded at ${intentPath}; refusing to overwrite it during removal`,
				retained: [intentPath],
			};
		}
		if (existingIntent === undefined) {
			const provenanceIdentity = await currentIdentity(provenancePath);
			const intent: IntentRecord = {
				version: INTENT_VERSION,
				step,
				targetPath,
				ownedKeys,
				targetPreflightIdentity: current.identity,
				targetExpectedIdentity: plan.expectedIdentity,
				provenancePath,
				provenancePreflightIdentity: provenanceIdentity,
				provenanceExpectedIdentity: provenanceIdentity,
				startedAt: now.toISOString(),
			};
			await writeIntent(intentPath, intent);
			ownsIntent = true;
		}
		await publishPlan(targetPath, plan, {
			expectedIdentity: current.identity,
			backup: false,
			now,
			onSourceClaimPrepared: async (claimPath, stagingPath, identity) => {
				const durable = await readIntent(intentPath);
				if (durable === undefined) {
					throw new PaseoPublishError(
						targetPath,
						{ reason: "cleanup-conflict", detail: `durable source-claim intent disappeared (${intentPath})` },
						[intentPath],
					);
				}
				if (path.resolve(durable.provenancePath) !== path.resolve(provenancePath)) {
					throw new PaseoPublishError(
						targetPath,
						{
							reason: "cleanup-conflict",
							detail: `durable source-claim intent names a different provenance ledger (${durable.provenancePath})`,
						},
						[intentPath],
					);
				}
				const receipt: SourceClaimReceipt & { readonly targetPath: string } = {
					targetPath,
					claimPath,
					stagingPath,
					identity,
				};
				sourceClaim = receipt;
				await writeIntent(intentPath, {
					...durable,
					sourceClaims: [...(durable.sourceClaims ?? []), receipt],
				});
			},
		});
		if (sourceClaim !== undefined) {
			const cleanup = await removeSourceClaim(sourceClaim);
			if (!cleanup.removed) {
				await retainSourceClaimReceipt(intentPath, sourceClaim, cleanup.retained);
				return {
					ok: false,
					detail: `source claim/staging cleanup remains pending at ${cleanup.retained.join(", ") || sourceClaim.claimPath}`,
					retained: [intentPath, ...cleanup.retained],
				};
			}
			await removeSourceClaimReceipt(intentPath, sourceClaim);
		}
		if (ownsIntent) await clearIntent(intentPath);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
			retained: [
				...(ownsIntent || sourceClaim !== undefined ? [intentPath] : []),
				...(sourceClaim === undefined ? [] : [sourceClaim.claimPath, sourceClaim.stagingPath]),
				...(error instanceof PaseoPublishError ? error.retained : []),
			],
		};
	}
}

function sourceClaimReceiptKey(receipt: SourceClaimReceipt & { readonly targetPath: string }): string {
	return [
		receipt.targetPath,
		receipt.claimPath,
		receipt.stagingPath,
		receipt.identity.dev,
		receipt.identity.ino,
		receipt.identity.parentDev,
		receipt.identity.parentIno,
		receipt.identity.size,
		receipt.identity.mtimeNs,
		receipt.identity.sha256,
	].join("\0");
}

async function retainSourceClaimReceipt(
	intentPath: string,
	receipt: SourceClaimReceipt & { readonly targetPath: string },
	retainedPaths: readonly string[],
): Promise<void> {
	const durable = await readIntent(intentPath);
	if (durable === undefined) return;
	const key = sourceClaimReceiptKey(receipt);
	const retained = { ...receipt, retainedPaths: [...new Set(retainedPaths)] };
	const sourceClaims = (durable.sourceClaims ?? []).map(candidate =>
		sourceClaimReceiptKey(candidate) === key ? retained : candidate,
	);
	if (!sourceClaims.some(candidate => sourceClaimReceiptKey(candidate) === key)) sourceClaims.push(retained);
	await writeIntent(intentPath, { ...durable, sourceClaims });
}

async function removeSourceClaimReceipt(
	intentPath: string,
	receipt: SourceClaimReceipt & { readonly targetPath: string },
): Promise<void> {
	const durable = await readIntent(intentPath);
	if (durable === undefined) throw new Error(`source claim authority disappeared before cleanup (${intentPath})`);
	const key = sourceClaimReceiptKey(receipt);
	const remaining = (durable.sourceClaims ?? []).filter(candidate => sourceClaimReceiptKey(candidate) !== key);
	if (remaining.length === (durable.sourceClaims ?? []).length) return;
	if (remaining.length === 0) {
		const { sourceClaims: _sourceClaims, ...withoutSourceClaims } = durable;
		await writeIntent(intentPath, withoutSourceClaims);
	} else {
		await writeIntent(intentPath, { ...durable, sourceClaims: remaining });
	}
}

function partial(
	removed: readonly string[],
	remaining: readonly string[],
	evidence: PartialRemovalEvidence,
): PaseoRemoveResult {
	return { outcome: "partial-removal", removed, remaining, evidence };
}
