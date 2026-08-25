import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type GjcBundleTransactionDecision,
	GjcPluginSourceUnavailableError,
	resolveGjcBundleCandidate,
	runGjcBundleTransaction,
} from "./installer";
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
import {
	readEffectiveRegistryUnpersisted,
	readRegistry,
	registryRootForScope,
	sortRegistryEntries,
	withRegistryLock,
	writeRegistryUnlocked,
} from "./registry";
import type {
	GjcBundleIdentity,
	GjcBundleSafeSource,
	GjcBundleSummary,
	GjcBundleSurfaceSummary,
	GjcInstallResult,
	GjcLifecycleError,
	GjcLifecycleResult,
	GjcPluginRegistry,
	GjcPluginRegistryEntry,
	GjcPluginRegistrySource,
	GjcPluginScope,
	GjcReviewedUpdateToken,
	GjcToggleResult,
	GjcUninstallPreview,
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
	/** User-scope registry root for this session; never fall back to process-global state. */
	agentDir?: string;
}

function fail(code: GjcLifecycleError["code"], message: string, recovery?: string): GjcLifecycleError {
	return recovery ? { code, message, recovery } : { code, message };
}
function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
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

async function readEffective(cwd: string, agentDir?: string): Promise<GjcPluginRegistryEntry[]> {
	const [user, project] = await Promise.all([
		readRegistry("user", cwd, { agentDir }),
		readRegistry("project", cwd, { agentDir }),
	]);
	return sortRegistryEntries([...user.plugins, ...project.plugins]);
}

/** All installed bundles across both scopes, deterministically ordered. */
export async function listGjcBundles(ctx: GjcLifecycleContext): Promise<GjcBundleSummary[]> {
	return (await readEffective(ctx.cwd, ctx.agentDir)).map(toBundleSummary);
}

/** One bundle by exact (scope, name) identity. Opposite scope never matches. */
export async function getGjcBundle(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
): Promise<GjcLifecycleResult<GjcBundleSummary>> {
	const registry = await readRegistry(identity.scope, ctx.cwd, { agentDir: ctx.agentDir });
	const entry = registry.plugins.find(p => p.name === identity.name);
	if (!entry) return { ok: false, error: notInstalled(identity) };
	return { ok: true, value: toBundleSummary(entry) };
}

function safeInstalledRoot(scope: GjcPluginScope, cwd: string, pluginRoot: string, agentDir?: string): string | null {
	const root = path.resolve(pluginRoot);
	const scopeRoot = path.resolve(registryRootForScope(scope, cwd, agentDir));
	const relative = path.relative(scopeRoot, root);
	if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
	return root;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isUninstallableEntry(value: unknown, identity: GjcBundleIdentity): value is GjcPluginRegistryEntry {
	if (!isRecord(value)) return false;
	if (
		value.name !== identity.name ||
		value.scope !== identity.scope ||
		typeof value.version !== "string" ||
		typeof value.enabled !== "boolean" ||
		typeof value.pluginRoot !== "string" ||
		typeof value.manifestPath !== "string" ||
		typeof value.manifestHash !== "string" ||
		typeof value.installedAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		!isStringArray(value.disabledSurfaceIds) ||
		!Array.isArray(value.copiedFiles)
	) {
		return false;
	}
	const source = value.source;
	if (
		!isRecord(source) ||
		typeof source.kind !== "string" ||
		typeof source.uri !== "string" ||
		typeof source.resolvedAt !== "string"
	) {
		return false;
	}
	const surfaces = value.surfaces;
	if (!isRecord(surfaces)) return false;
	for (const key of ["subskills", "tools", "hooks", "mcps", "systemAppendices", "agentAppendices"]) {
		const list = surfaces[key];
		if (
			!Array.isArray(list) ||
			!list.every(item => isRecord(item) && typeof item.extensionId === "string" && typeof item.name === "string")
		) {
			return false;
		}
	}
	if (
		!value.copiedFiles.every(
			file =>
				isRecord(file) &&
				typeof file.relativePath === "string" &&
				typeof file.sha256 === "string" &&
				typeof file.bytes === "number",
		)
	) {
		return false;
	}
	if (value.quarantine !== undefined) {
		if (
			!Array.isArray(value.quarantine) ||
			!value.quarantine.every(
				entry => isRecord(entry) && typeof entry.surfaceId === "string" && typeof entry.code === "string",
			)
		) {
			return false;
		}
	}
	return true;
}

function isMalformedRegistryError(error: unknown): boolean {
	return (
		(error instanceof GjcPluginLoadError && error.code === "invalid_manifest") ||
		(error instanceof TypeError &&
			/(?:not iterable|localeCompare|reading ['"](?:scope|name|pluginRoot|plugins|map))/.test(error.message))
	);
}

function uninstallFailure(
	identity: GjcBundleIdentity,
	kind: "metadata" | "remove" | "write" | "restore",
): GjcLifecycleError {
	const detail =
		kind === "metadata"
			? "its installed metadata is invalid"
			: kind === "remove"
				? "the installed files could not be moved safely"
				: kind === "write"
					? "its registry could not be updated"
					: "the previous state could not be restored";
	const recovery =
		kind === "metadata"
			? `Repair the GJC ${identity.scope} registry, then retry gjc plugin uninstall ${identity.name} --${identity.scope}`
			: `Check GJC plugin directory permissions, then retry gjc plugin uninstall ${identity.name} --${identity.scope}`;
	return fail("invalid_target", `Could not uninstall GJC bundle "${identity.name}" because ${detail}`, recovery);
}

/**
 * Resolve and validate the uninstall target. Read-only: it is the shared
 * preflight for the preview and for the mutating uninstall, so a preview
 * refuses exactly what the real uninstall would refuse.
 */
function resolveUninstallTarget(
	registry: GjcPluginRegistry,
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
): GjcLifecycleResult<{ entry: GjcPluginRegistryEntry; root: string }> {
	const entry = registry.plugins.find(plugin => plugin && plugin.name === identity.name);
	if (!entry) return { ok: false, error: notInstalled(identity) };
	if (!isUninstallableEntry(entry, identity)) return { ok: false, error: uninstallFailure(identity, "metadata") };

	const root = safeInstalledRoot(identity.scope, ctx.cwd, entry.pluginRoot, ctx.agentDir);
	if (!root) return { ok: false, error: uninstallFailure(identity, "metadata") };
	return { ok: true, value: { entry, root } };
}

async function readUninstallRegistry(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
	read: (scope: GjcPluginScope, cwd: string, agentDir?: string) => Promise<GjcPluginRegistry>,
	onMalformed: (identity: GjcBundleIdentity) => GjcLifecycleError,
): Promise<GjcLifecycleResult<GjcPluginRegistry>> {
	try {
		return { ok: true, value: await read(identity.scope, ctx.cwd, ctx.agentDir) };
	} catch (error) {
		if (isMalformedRegistryError(error)) return { ok: false, error: onMalformed(identity) };
		throw error;
	}
}

/**
 * What {@link uninstallGjcBundle} would remove, resolved and validated the same
 * way, without removing it.
 *
 * Strictly read-only: no registry lock is taken (acquiring it creates the scope
 * root and a lockfile) and no migration is persisted, while legacy-root
 * discovery and entry migration are still applied in memory so the preview sees
 * exactly the entries the real uninstall would act on.
 *
 * A malformed registry reads back as the internal `registry_unreadable` signal:
 * the CLI's classification uses it to fail closed, because the unreadable scope
 * may own the requested name and ownership must never be guessed. The exported
 * mutating {@link uninstallGjcBundle} keeps mapping the same condition to
 * `invalid_target`, its historical result contract.
 */
export async function previewGjcBundleUninstall(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
): Promise<GjcLifecycleResult<GjcUninstallPreview>> {
	const registry = await readUninstallRegistry(ctx, identity, readEffectiveRegistryUnpersisted, registryUnreadable);
	if (!registry.ok) return registry;
	const target = resolveUninstallTarget(registry.value, ctx, identity);
	if (!target.ok) return target;
	return { ok: true, value: { status: "would-uninstall", identity, summary: toBundleSummary(target.value.entry) } };
}

export async function uninstallGjcBundle(
	ctx: GjcLifecycleContext,
	identity: GjcBundleIdentity,
): Promise<GjcLifecycleResult<{ identity: GjcBundleIdentity; summary: GjcBundleSummary }>> {
	return withRegistryLock(
		identity.scope,
		ctx.cwd,
		async () => {
			// The mutating API's historical contract maps a malformed registry to the
			// generic invalid_target metadata failure; only the read-only preview
			// surfaces the internal registry_unreadable classification signal.
			const read = await readUninstallRegistry(
				ctx,
				identity,
				(scope, cwd, agentDir) => readRegistry(scope, cwd, { migrate: false, agentDir }),
				failing => uninstallFailure(failing, "metadata"),
			);
			if (!read.ok) return read;
			const registry = read.value;

			const target = resolveUninstallTarget(registry, ctx, identity);
			if (!target.ok) return target;
			const { entry, root } = target.value;

			const summary = toBundleSummary(entry);
			const nextRegistry = { ...registry, plugins: registry.plugins.filter(plugin => plugin !== entry) };
			const backupRoot = `${root}.uninstalling-${process.pid}-${Date.now()}`;
			let moved = false;

			try {
				await fs.rename(root, backupRoot);
				moved = true;
			} catch (error) {
				if (!isEnoent(error)) return { ok: false, error: uninstallFailure(identity, "remove") };
			}

			try {
				await writeRegistryUnlocked(nextRegistry, ctx.cwd, identity.scope, ctx.agentDir);
			} catch {
				if (moved) {
					try {
						await fs.rename(backupRoot, root);
					} catch {
						return { ok: false, error: uninstallFailure(identity, "restore") };
					}
				}
				return { ok: false, error: uninstallFailure(identity, "write") };
			}

			if (moved) {
				try {
					await fs.rm(backupRoot, { recursive: true, force: true });
				} catch {
					try {
						await writeRegistryUnlocked(registry, ctx.cwd, identity.scope, ctx.agentDir);
						await fs.rename(backupRoot, root);
					} catch {
						return { ok: false, error: uninstallFailure(identity, "restore") };
					}
					return { ok: false, error: uninstallFailure(identity, "remove") };
				}
			}
			return { ok: true, value: { identity, summary } };
		},
		ctx.agentDir,
	);
}

function notInstalled(identity: GjcBundleIdentity): GjcLifecycleError {
	return fail(
		"not_installed",
		`GJC bundle "${identity.name}" is not installed in the ${identity.scope} scope`,
		`gjc plugin install <source> --${identity.scope}`,
	);
}
/**
 * The scope registry itself could not be read (corrupt JSON, wrong shape). The
 * real uninstall path surfaces this from the classification read as a thrown
 * load error that callers treat as "GJC does not own this scope right now"; the
 * preview must classify the same way instead of claiming the target.
 */
function registryUnreadable(identity: GjcBundleIdentity): GjcLifecycleError {
	return fail(
		"registry_unreadable",
		`Could not read the GJC ${identity.scope} plugin registry while resolving "${identity.name}"`,
		`Repair the GJC ${identity.scope} registry (gjc plugin doctor --fix), then retry`,
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
		// Only source resolution failures are retryable. Candidate compilation,
		// identity, schema, and validation failures remain typed invalid-target
		// results instead of being mislabeled as unavailable sources.
		if (error instanceof GjcPluginSourceUnavailableError) {
			return {
				ok: false,
				error: fail(
					"source_unavailable",
					`The stored source for GJC bundle "${identity.name}" could not be resolved`,
					`gjc plugin install <source> --${identity.scope}`,
				),
			};
		}
		if (error instanceof GjcPluginLoadError) {
			return {
				ok: false,
				error: fail(
					"invalid_target",
					`Stored source for GJC bundle "${identity.name}" is no longer a valid plugin target`,
					`gjc plugin install <source> --${identity.scope}`,
				),
			};
		}
		throw error;
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
		const registry = await readRegistry(scope, ctx.cwd, { migrate: false, agentDir: ctx.agentDir });
		const existing = registry.plugins.find(p => p.name === declared);
		if (existing) return { ok: false, error: alreadyInstalled(existing.name, scope) };
	}

	let result: Awaited<ReturnType<typeof runGjcBundleTransaction>>;
	try {
		result = await runGjcBundleTransaction(source, {
			scope,
			cwd: ctx.cwd,
			agentDir: ctx.agentDir,
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
	} catch (error) {
		if (error instanceof GjcPluginSourceUnavailableError) {
			throw new GjcPluginLoadError("missing_file", "GJC plugin source directory not found");
		}
		throw error;
	}
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
	const registry = await readRegistry(identity.scope, ctx.cwd, { agentDir: ctx.agentDir });
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

	const effective = await readEffective(ctx.cwd, ctx.agentDir);
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
	const registry = await readRegistry(identity.scope, ctx.cwd, { agentDir: ctx.agentDir });
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
			agentDir: ctx.agentDir,
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
	return await withRegistryLock(
		identity.scope,
		ctx.cwd,
		async () => {
			const registry = await readRegistry(identity.scope, ctx.cwd, { migrate: false, agentDir: ctx.agentDir });
			const entry = registry.plugins.find(p => p.name === identity.name);
			if (!entry) return { ok: false, error: notInstalled(identity) };
			const outcome = mutate(entry);
			if (!outcome.ok) return { ok: false, error: outcome.error };
			if (outcome.value === null) return { ok: true, value: { summary: toBundleSummary(entry), mutated: false } };
			const next = sortRegistryEntries([...registry.plugins.filter(p => p.name !== identity.name), outcome.value]);
			await writeRegistryUnlocked(
				{ version: 1, scope: identity.scope, plugins: next },
				ctx.cwd,
				identity.scope,
				ctx.agentDir,
			);
			return { ok: true, value: { summary: toBundleSummary(outcome.value), mutated: true } };
		},
		ctx.agentDir,
	);
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
	return activationFingerprint(await readEffective(ctx.cwd, ctx.agentDir));
}
