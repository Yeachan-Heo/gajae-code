import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GjcBundleTransactionDecision, resolveGjcBundleCandidate, runGjcBundleTransaction } from "./installer";
import {
	activationFingerprint,
	baselineFingerprint,
	bundleIdentity,
	candidateFingerprint,
	decisionContextFingerprint,
	diffSurfaceIds,
	identityEquals,
	reconcileEnablement,
	surfaceIdsOf,
	targetFingerprint,
} from "./lifecycle-reconciliation";
import { readRegistry, sortRegistryEntries, withRegistryLock, writeRegistryUnlocked } from "./registry";
import type {
	GjcBundleIdentity,
	GjcBundleSafeSource,
	GjcBundleSummary,
	GjcBundleSurfaceSummary,
	GjcInstallResult,
	GjcLifecycleError,
	GjcLifecycleResult,
	GjcPluginRegistryEntry,
	GjcPluginRegistrySource,
	GjcPluginScope,
	GjcReviewedUpdateToken,
	GjcToggleResult,
	GjcUpdateApplyResult,
	GjcUpdatePreview,
} from "./types";
import { GJC_PLUGIN_MANIFEST_FILENAME, GjcPluginLoadError } from "./types";

/**
 * GJC bundle lifecycle service.
 *
 * This module is the ONLY policy and persistence writer for GJC bundles: fresh
 * install, update preview/apply, bundle enable/disable, and surface
 * enable/disable. Callers (CLI, Settings) never touch the registry writers or
 * the installer transaction directly.
 */

export interface GjcLifecycleContext {
	cwd: string;
}

function fail(code: GjcLifecycleError["code"], message: string, recovery?: string): GjcLifecycleError {
	return recovery ? { code, message, recovery } : { code, message };
}

const UNSUPPORTED_UPDATE_REASON: Partial<Record<GjcPluginRegistrySource["kind"], string>> = {};

/**
 * Redact a stored locator to a display form: host + path only. No userinfo,
 * query, fragment, credentials, or parent-directory segments reach output.
 */
const SAFE_LOCATOR_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_HOST = /^[A-Za-z0-9.-]+$/;
const SAFE_REF = /^[A-Za-z0-9._/-]{1,128}$/;
const SAFE_SHA = /^[A-Fa-f0-9]{1,128}$/;

function safePathSegments(value: string): string[] {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.flatMap(segment => {
			try {
				return [decodeURIComponent(segment)];
			} catch {
				return [];
			}
		})
		.filter(segment => segment !== "." && !segment.includes("..") && SAFE_LOCATOR_SEGMENT.test(segment));
}

function displayPath(segments: string[]): string {
	return segments.join("/").replace(/\.git$/i, "");
}

function safeRef(value: string | undefined): string | undefined {
	if (value === undefined || !SAFE_REF.test(value) || value.startsWith("/") || value.includes("..")) return undefined;
	return value;
}

function safeSha(value: string | undefined): string | undefined {
	return value !== undefined && SAFE_SHA.test(value) ? value : undefined;
}

function localPathDisplay(value: string, fallback: string): string {
	const segments = safePathSegments(value);
	return segments.at(-1) ?? fallback;
}

export function redactSourceLocator(source: GjcPluginRegistrySource): string {
	const unc = /^(?:\\\\|\/\/)(.+)$/.exec(source.uri);
	if (unc) {
		const [host, ...segments] = safePathSegments(unc[1] ?? "");
		if (host && SAFE_HOST.test(host)) {
			const safePath = displayPath(segments);
			return safePath ? `${host}/${safePath}` : host;
		}
		return source.kind;
	}

	if (/^[A-Za-z]:[\\/]/.test(source.uri)) return localPathDisplay(source.uri, source.kind);
	if (source.kind === "path" || /^(?:\.{1,2}[\\/]|[\\/])/.test(source.uri)) {
		return localPathDisplay(source.uri, source.kind);
	}

	try {
		const url = new URL(source.uri);
		if (!SAFE_HOST.test(url.hostname)) return source.kind;
		const safePath = displayPath(safePathSegments(url.pathname));
		return safePath ? `${url.hostname}/${safePath}` : url.hostname;
	} catch {
		const scp = /^[^@/:]+@([A-Za-z0-9.-]+):(.+)$/.exec(source.uri);
		if (scp) {
			const safePath = displayPath(safePathSegments(scp[2] ?? ""));
			return safePath ? `${scp[1]}/${safePath}` : (scp[1] ?? source.kind);
		}
		return source.kind;
	}
}

function toSafeSource(source: GjcPluginRegistrySource): GjcBundleSafeSource {
	const unsupportedReason = UNSUPPORTED_UPDATE_REASON[source.kind];
	const safe: GjcBundleSafeSource = {
		kind: source.kind,
		display: redactSourceLocator(source),
		resolvedAt: source.resolvedAt,
		updatable: unsupportedReason === undefined,
	};
	const ref = safeRef(source.ref);
	const sha = safeSha(source.sha);
	if (ref !== undefined) safe.ref = ref;
	if (sha !== undefined) safe.sha = sha;
	if (unsupportedReason !== undefined) safe.unsupportedReason = unsupportedReason;
	return safe;
}

function surfaceSummaries(entry: GjcPluginRegistryEntry): GjcBundleSurfaceSummary[] {
	const disabled = new Set(entry.disabledSurfaceIds);
	const quarantined = new Map((entry.quarantine ?? []).map(q => [q.surfaceId, q.code]));
	const rows: GjcBundleSurfaceSummary[] = [
		...entry.surfaces.subskills.map(s => ({ extensionId: s.extensionId, kind: "subskill" as const, name: s.name })),
		...entry.surfaces.tools.map(t => ({ extensionId: t.extensionId, kind: "tool" as const, name: t.name })),
		...entry.surfaces.hooks.map(h => ({ extensionId: h.extensionId, kind: "hook" as const, name: h.name })),
		...entry.surfaces.mcps.map(m => ({ extensionId: m.extensionId, kind: "mcp" as const, name: m.name })),
		...entry.surfaces.systemAppendices.map(a => ({
			extensionId: a.extensionId,
			kind: "system-appendix" as const,
			name: a.name,
		})),
		...entry.surfaces.agentAppendices.map(a => ({
			extensionId: a.extensionId,
			kind: "agent-appendix" as const,
			name: a.name,
		})),
	].map(row => {
		const code = quarantined.get(row.extensionId);
		const summary: GjcBundleSurfaceSummary = {
			...row,
			enabled: !disabled.has(row.extensionId),
			quarantined: code !== undefined,
		};
		if (code !== undefined) summary.quarantineCode = code;
		return summary;
	});
	return rows.sort((a, b) => a.extensionId.localeCompare(b.extensionId));
}

/** Safe, redacted DTO for one installed bundle. */
export function toBundleSummary(entry: GjcPluginRegistryEntry): GjcBundleSummary {
	const surfaces = surfaceSummaries(entry);
	return {
		identity: bundleIdentity(entry.scope, entry.name),
		version: entry.version,
		enabled: entry.enabled,
		source: toSafeSource(entry.source),
		installedAt: entry.installedAt,
		updatedAt: entry.updatedAt,
		manifestHash: entry.manifestHash,
		targetFingerprint: targetFingerprint(entry),
		surfaces,
		quarantined: surfaces.some(s => s.quarantined),
	};
}

/**
 * Rebuild the exact locator an update must re-resolve from. A git ref is stored
 * separately from the URI, so re-resolving the bare URI would silently drop the
 * reviewed branch or tag and update from the default branch instead.
 */
function storedSourceLocator(source: GjcPluginRegistrySource): string {
	return source.kind === "git" && source.ref ? `${source.uri}#${source.ref}` : source.uri;
}

/** Exposed for locator-reconstruction tests; not part of the lifecycle API. */
export const storedSourceLocatorForTest = storedSourceLocator;

/** Exposed so a test can pin parity with the installer's source predicates. */
export const isLocalDirectorySourceForTest = isLocalDirectorySource;

async function readEffective(cwd: string): Promise<GjcPluginRegistryEntry[]> {
	const [user, project] = await Promise.all([readRegistry("user", cwd), readRegistry("project", cwd)]);
	return sortRegistryEntries([...user.plugins, ...project.plugins]);
}

/** All installed bundles across both scopes, deterministically ordered. */
export async function listGjcBundles(ctx: GjcLifecycleContext): Promise<GjcBundleSummary[]> {
	return (await readEffective(ctx.cwd)).map(toBundleSummary);
}

/** One bundle by exact (scope, name) identity. Opposite scope never matches. */
export async function getGjcBundle(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
): Promise<GjcLifecycleResult<GjcBundleSummary>> {
	const registry = await readRegistry(identity.scope, ctx.cwd);
	const entry = registry.plugins.find(p => p.name === identity.name);
	if (!entry) return { ok: false, error: notInstalled(identity) };
	return { ok: true, value: toBundleSummary(entry) };
}

function notInstalled(identity: GjcBundleIdentity): GjcLifecycleError {
	return fail(
		"not_installed",
		`GJC bundle "${identity.name}" is not installed in the ${identity.scope} scope`,
		`gjc plugin install <source> --${identity.scope}`,
	);
}

function alreadyInstalled(name: string, scope: GjcPluginScope): GjcLifecycleError {
	return fail(
		"already_installed_use_upgrade",
		`GJC bundle "${name}" is already installed in the ${scope} scope`,
		`gjc plugin upgrade ${name} --${scope}`,
	);
}

/**
 * Run a source-resolving operation and convert a resolution failure into the
 * typed `source_unavailable` result the lifecycle contract promises.
 *
 * Re-resolution reaches the network and the filesystem, so it can throw with a
 * message carrying the stored locator. Letting that escape would both crash the
 * CLI with an unhandled rejection and echo an absolute path, which is the exact
 * leak class the safe DTOs exist to prevent.
 */
async function withSourceAvailability<T>(
	identity: GjcBundleIdentity,
	run: () => Promise<GjcLifecycleResult<T>>,
): Promise<GjcLifecycleResult<T>> {
	try {
		return await run();
	} catch (error) {
		// Only a source-resolution failure becomes `source_unavailable`. A
		// programming bug, an out-of-memory, or a write/rollback fault must keep
		// propagating: mislabelling those as an unreachable source would hide real
		// failures behind a benign-looking, retryable error.
		if (!(error instanceof GjcPluginLoadError)) throw error;
		return {
			ok: false,
			error: fail(
				"source_unavailable",
				`The stored source for GJC bundle "${identity.name}" could not be resolved`,
				`gjc plugin install <source> --${identity.scope}`,
			),
		};
	}
}

/**
 * True only for strings the installer would treat as a local path rather than
 * a remote locator. This deliberately mirrors the installer's own `looksLikeGit`
 * predicate: if the two ever disagreed, a remote locator could be read as a
 * relative path and shadowed by a local directory of the same shape.
 */
function isLocalDirectorySource(source: string): boolean {
	// Mirrors installer `looksLikeGit`.
	if (/^(https?|ssh|git):\/\//i.test(source)) return false;
	if (/^git@/.test(source)) return false;
	if (source.startsWith("git:")) return false;
	// Mirrors installer `isTarball`: a local archive is extracted, not read in
	// place, so its manifest is not at `<source>/gajae-plugin.json`.
	if (/\.(tgz|tar\.gz|tar)$/i.test(source)) return false;
	// Any other scheme-qualified locator is likewise not a local directory.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
	// scp-style `user@host:path` and bare `host:port/path` forms are remote.
	if (/^[^@/\s]+@[^:/\s]+:/.test(source)) return false;
	if (/^[^/\s:]+:\d+\//.test(source)) return false;
	return true;
}

/** Largest manifest this preflight will read before giving up. */
const PREFLIGHT_MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * Bundle name declared by a local directory source, read without resolving or
 * compiling it so a create-only refusal does not depend on the source being
 * fetchable. Returns undefined for anything that is not a plain local
 * directory, for symlinked or oversized manifests, and for unreadable or
 * malformed content, in which case the caller falls through to the
 * transaction's own pre-lock preflight.
 *
 * This can only cause a refusal, never a commit, and the locked decision
 * re-derives the identity from the compiled bundle.
 */
async function declaredBundleName(source: string): Promise<string | undefined> {
	// Classify the locator BEFORE touching the filesystem. On POSIX a remote
	// locator like `https://host/repo` is also a valid relative path
	// (`https:/host/repo`), so statting first would let a locally created
	// directory shadow a remote source and refuse an install that should have
	// resolved remotely.
	if (!isLocalDirectorySource(source)) return undefined;
	let handle: fs.FileHandle | undefined;
	try {
		const dir = await fs.stat(source);
		if (!dir.isDirectory()) return undefined;
		const manifestPath = path.join(source, GJC_PLUGIN_MANIFEST_FILENAME);
		// Open without following a final symlink, then stat the OPEN handle so a
		// concurrent rename cannot swap in a symlink or an oversized file between
		// the check and the read.
		handle = await fs.open(manifestPath, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
		const manifest = await handle.stat();
		if (!manifest.isFile() || manifest.size > PREFLIGHT_MANIFEST_MAX_BYTES) return undefined;
		const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
		const name = (parsed as { name?: unknown }).name;
		return typeof name === "string" && name.length > 0 ? name : undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Fresh install only. An existing target in the same scope is create-only and
 * is refused identically with or without force; upgrading is a separate,
 * scope-qualified operation.
 */
export async function installGjcBundle(
	ctx: GjcLifecycleContext,
	scope: GjcPluginScope,
	source: string,
): Promise<GjcLifecycleResult<GjcInstallResult>> {
	// A create-only refusal must not depend on the source being reachable, so
	// identify the target before resolving anything. Only the declared manifest
	// name can do that: it IS the canonical identity component.
	//
	// A stored-locator match deliberately does NOT qualify. One locator can
	// resolve to different content over time, and the same URI can back two
	// differently named bundles, so matching on it would refuse installs that
	// should proceed. When the name cannot be read the transaction's own
	// pre-lock preflight refuses after resolving.
	const declared = await declaredBundleName(source);
	if (declared) {
		const registry = await readRegistry(scope, ctx.cwd);
		const existing = registry.plugins.find(p => p.name === declared);
		if (existing) return { ok: false, error: alreadyInstalled(existing.name, scope) };
	}

	const result = await runGjcBundleTransaction(source, {
		scope,
		cwd: ctx.cwd,
		decide: async ({ existing, candidate }): Promise<GjcBundleTransactionDecision> => {
			if (existing) {
				return {
					kind: "abort",
					error: fail(
						"already_installed_use_upgrade",
						`GJC bundle "${existing.name}" is already installed in the ${scope} scope`,
						`gjc plugin upgrade ${existing.name} --${scope}`,
					),
				};
			}
			return { kind: "commit", entry: candidate };
		},
	});
	if (result.status === "aborted") return { ok: false, error: result.error };
	return { ok: true, value: { status: "installed", summary: toBundleSummary(result.entry) } };
}

/**
 * Re-resolve the stored source descriptor and describe what an update would do.
 * The returned token binds the candidate, the exact installed baseline, and the
 * deterministic decision context; apply is a compare-and-swap on all three.
 */
export async function previewGjcBundleUpdate(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
): Promise<GjcLifecycleResult<GjcUpdatePreview>> {
	const registry = await readRegistry(identity.scope, ctx.cwd);
	const entry = registry.plugins.find(p => p.name === identity.name);
	if (!entry) return { ok: false, error: notInstalled(identity) };
	const safeSource = toSafeSource(entry.source);
	if (!safeSource.updatable) {
		return {
			ok: false,
			error: fail(
				"source_unsupported",
				`GJC bundle "${identity.name}" was installed from a ${entry.source.kind} source that cannot be re-resolved`,
			),
		};
	}

	const effective = await readEffective(ctx.cwd);
	// Re-resolution reaches the network and the filesystem, so it can throw with
	// a cause carrying the raw locator. Convert that into the typed
	// `source_unavailable` result the contract promises, rather than letting an
	// exception escape and echo the stored path.
	return await withSourceAvailability(identity, async () =>
		resolveGjcBundleCandidate(storedSourceLocator(entry.source), async ({ bundle }) => {
			if (bundle.name !== entry.name) {
				return {
					ok: false as const,
					error: fail(
						"identity_mismatch",
						`Source now declares "${bundle.name}" but "${entry.name}" is installed; install the new bundle and uninstall the old one`,
						`gjc plugin install <source> --${identity.scope}`,
					),
				};
			}
			const candidateIds = surfaceIdsOf(bundle.surfaces);
			const delta = diffSurfaceIds(surfaceIdsOf(entry.surfaces), candidateIds);
			const candidateHash = candidateFingerprint(identity.scope, bundle);
			const baselineHash = baselineFingerprint(entry);
			const contextHash = decisionContextFingerprint(identity, effective);
			const token: GjcReviewedUpdateToken = {
				identity,
				candidateFingerprint: candidateHash,
				baselineFingerprint: baselineHash,
				decisionContextFingerprint: contextHash,
				reviewedAt: new Date().toISOString(),
			};
			return {
				ok: true as const,
				value: {
					identity,
					current: toBundleSummary(entry),
					candidateVersion: bundle.version,
					candidateManifestHash: bundle.manifestHash,
					addedSurfaceIds: delta.addedSurfaceIds,
					removedSurfaceIds: delta.removedSurfaceIds,
					retainedSurfaceIds: delta.retainedSurfaceIds,
					changed: candidateHash !== targetFingerprint(entry),
					token,
				},
			};
		}),
	);
}

/**
 * Apply a previously reviewed update. Any drift in the candidate bytes, the
 * installed baseline, or the decision context returns a typed stale error with
 * zero mutation.
 */
export async function applyGjcBundleUpdate(
	ctx: GjcLifecycleContext,
	token: GjcReviewedUpdateToken,
): Promise<GjcLifecycleResult<GjcUpdateApplyResult>> {
	const identity = token.identity;
	const registry = await readRegistry(identity.scope, ctx.cwd);
	const entry = registry.plugins.find(p => p.name === identity.name);
	if (!entry) return { ok: false, error: notInstalled(identity) };
	if (!toSafeSource(entry.source).updatable) {
		return {
			ok: false,
			error: fail(
				"source_unsupported",
				`GJC bundle "${identity.name}" was installed from a ${entry.source.kind} source that cannot be re-resolved`,
			),
		};
	}

	return await withSourceAvailability<GjcUpdateApplyResult>(identity, async () => {
		const result = await runGjcBundleTransaction(storedSourceLocator(entry.source), {
			scope: identity.scope,
			cwd: ctx.cwd,
			decide: async ({ existing, effective, bundle, candidate }): Promise<GjcBundleTransactionDecision> => {
				if (!existing) return { kind: "abort", error: notInstalled(identity) };
				if (
					bundle.name !== existing.name ||
					!identityEquals(bundleIdentity(identity.scope, bundle.name), identity)
				) {
					return {
						kind: "abort",
						error: fail(
							"identity_mismatch",
							`Source now declares "${bundle.name}" but "${existing.name}" is installed; install the new bundle and uninstall the old one`,
							`gjc plugin install <source> --${identity.scope}`,
						),
					};
				}
				const candidateHash = candidateFingerprint(identity.scope, bundle);
				if (candidateHash !== token.candidateFingerprint) {
					return {
						kind: "abort",
						error: fail("stale_candidate", "The source changed since it was reviewed; preview the update again"),
					};
				}
				const baselineHash = baselineFingerprint(existing);
				if (baselineHash !== token.baselineFingerprint) {
					return {
						kind: "abort",
						error: fail(
							"stale_baseline",
							"The installed bundle changed since it was reviewed; preview the update again",
						),
					};
				}
				const contextHash = decisionContextFingerprint(identity, effective);
				if (contextHash !== token.decisionContextFingerprint) {
					return {
						kind: "abort",
						error: fail(
							"stale_decision_context",
							"Installed bundles changed since the update was reviewed; preview the update again",
						),
					};
				}
				if (candidateHash === targetFingerprint(existing)) return { kind: "noop", entry: existing };

				// Quarantine is recomputed against the candidate, never carried forward,
				// so a surface the update fixes is not left permanently blocked.
				const reconciled = reconcileEnablement(existing.disabledSurfaceIds, surfaceIdsOf(bundle.surfaces));
				const next: GjcPluginRegistryEntry = {
					...candidate,
					enabled: existing.enabled,
					installedAt: existing.installedAt,
					disabledSurfaceIds: reconciled.disabledSurfaceIds,
				};
				if (reconciled.quarantine.length > 0) next.quarantine = reconciled.quarantine;
				else delete next.quarantine;
				return { kind: "commit", entry: next };
			},
		});

		if (result.status === "aborted") return { ok: false, error: result.error };
		if (result.status === "noop") {
			return { ok: true, value: { status: "unchanged", summary: toBundleSummary(result.entry), remnantCount: 0 } };
		}
		return {
			ok: true,
			value: { status: "updated", summary: toBundleSummary(result.entry), remnantCount: result.remnants.length },
		};
	});
}

async function mutateEntry(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
	mutate: (entry: GjcPluginRegistryEntry) => GjcLifecycleResult<GjcPluginRegistryEntry | null>,
): Promise<GjcLifecycleResult<GjcToggleResult>> {
	return await withRegistryLock(identity.scope, ctx.cwd, async () => {
		const registry = await readRegistry(identity.scope, ctx.cwd);
		const entry = registry.plugins.find(p => p.name === identity.name);
		if (!entry) return { ok: false, error: notInstalled(identity) };
		const outcome = mutate(entry);
		if (!outcome.ok) return { ok: false, error: outcome.error };
		if (outcome.value === null) return { ok: true, value: { summary: toBundleSummary(entry), mutated: false } };
		const next = sortRegistryEntries([...registry.plugins.filter(p => p.name !== identity.name), outcome.value]);
		await writeRegistryUnlocked({ version: 1, scope: identity.scope, plugins: next }, ctx.cwd);
		return { ok: true, value: { summary: toBundleSummary(outcome.value), mutated: true } };
	});
}

/**
 * Enable or disable a whole bundle. Deterministic quarantine blocks enabling;
 * disabling is always allowed so operators can always de-escalate.
 */
export async function setGjcBundleEnabled(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
	enabled: boolean,
): Promise<GjcLifecycleResult<GjcToggleResult>> {
	return await mutateEntry(ctx, identity, entry => {
		if (enabled && (entry.quarantine?.length ?? 0) > 0) {
			return {
				ok: false,
				error: fail("quarantined", `GJC bundle "${identity.name}" is quarantined and cannot be enabled`),
			};
		}
		if (entry.enabled === enabled) return { ok: true, value: null };
		return { ok: true, value: { ...entry, enabled, updatedAt: new Date().toISOString() } };
	});
}

/** Enable or disable one surface of a bundle by its stable extension ID. */
export async function setGjcBundleSurfaceEnabled(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
	surfaceId: string,
	enabled: boolean,
): Promise<GjcLifecycleResult<GjcToggleResult>> {
	return await mutateEntry(ctx, identity, entry => {
		if (!surfaceIdsOf(entry.surfaces).includes(surfaceId)) {
			return {
				ok: false,
				error: fail("surface_unknown", `GJC bundle "${identity.name}" has no surface "${surfaceId}"`),
			};
		}
		if (enabled && (entry.quarantine ?? []).some(q => q.surfaceId === surfaceId)) {
			return {
				ok: false,
				error: fail("quarantined", `Surface "${surfaceId}" is quarantined and cannot be enabled`),
			};
		}
		const disabled = new Set(entry.disabledSurfaceIds);
		if (enabled ? !disabled.has(surfaceId) : disabled.has(surfaceId)) return { ok: true, value: null };
		if (enabled) disabled.delete(surfaceId);
		else disabled.add(surfaceId);
		return {
			ok: true,
			value: { ...entry, disabledSurfaceIds: [...disabled].sort(), updatedAt: new Date().toISOString() },
		};
	});
}

/** Deterministic activation generation for the current persisted state. */
export async function currentActivationFingerprint(ctx: GjcLifecycleContext): Promise<string> {
	return activationFingerprint(await readEffective(ctx.cwd));
}
