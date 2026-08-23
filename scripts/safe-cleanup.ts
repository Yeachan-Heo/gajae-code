/**
 * Fail-closed recursive-deletion boundary for test processes (issue #4794).
 *
 * An operator's real `$HOME` was destroyed by test cleanup activity. The
 * structural fix is a single verdict function every deletion path consults:
 * a recursive removal is permitted ONLY when the target is a strictly-nested,
 * process-owned path inside an explicitly allowed root (a supported OS temp
 * root or this repository worktree), and is NEVER the real home, an ancestor
 * of it, the filesystem root, a shallow path, or a symlink-resolved escape.
 *
 * Enforcement layers (they complement each other; none is sufficient alone):
 *
 * 1. `safeRm`/`safeRmSync` — the explicit contract. Migrated cleanup code
 *    calls these; a refusal throws `SafeCleanupRefusalError` so the failure is
 *    a normal, attributable test error.
 * 2. `installRuntimeDeletionGuard()` — a last-resort runtime backstop for the
 *    surfaces Bun 1.4.0 actually allows intercepting: the shared `fs.promises`
 *    object (`fs.promises.rm`/`rmdir` and `import { promises }`) and the CJS
 *    `require("node:fs")`/`require("node:fs/promises")` exports objects.
 *    ESM namespace bindings (`import * as fs` top-level `rmSync`/`rm`) are
 *    immutable snapshots in Bun and CANNOT be intercepted at runtime — that
 *    gap is closed by layer 3, and the interception matrix is pinned by
 *    `safe-cleanup-guard.test.ts` so a future runtime change is detected.
 * 3. `scripts/check-unsafe-rmrf.ts` — the static guard that bans raw
 *    recursive `fs.rm*`/`fs.rmdir*` calls in HOME-seam test files, making the
 *    un-interceptable sync surface deterministic at check time.
 *
 * The guard is test-process-scoped on purpose: it is installed only from
 * `scripts/test-preload.ts` (bunfig `[test] preload`). Product runtime and
 * non-test tooling never load it, so third-party and production behavior is
 * untouched. Within a test process, a third-party dependency that recursively
 * deletes inside the allowed roots keeps working; anything else aborts the
 * process — that is the intended fail-closed behavior.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type * as fsTypes from "node:fs";

/** Either platform flavor of the node:path API (posix or win32 semantics). */
export type PlatformPath = typeof path.posix | typeof path.win32;

export type DeletionRefusalReason =
	| "empty-target"
	| "relative-target"
	| "filesystem-root"
	| "too-shallow"
	| "real-home"
	| "real-home-ancestor"
	| "outside-allowed-roots"
	| "symlink-escape"
	| "unowned-path";

export interface DeletionRefusal {
	ok: false;
	reason: DeletionRefusalReason;
	message: string;
	target: string;
}

export interface DeletionApproval {
	ok: true;
	target: string;
	/** Symlink-resolved absolute path (equals `target` resolution when absent on disk). */
	canonicalTarget: string;
	/** The allowed root the canonical target is strictly nested inside. */
	containedRoot: string;
}

export type DeletionVerdict = DeletionApproval | DeletionRefusal;

/**
 * Everything the verdict needs, injectable so the decision table is
 * unit-testable on any platform (posix semantics via `path.win32`, synthetic
 * filesystems via fake `realpathSync`/`statUid`).
 */
export interface SafeCleanupWorld {
	pathModule: PlatformPath;
	/** Absolute home paths that must never be deleted (real home + its realpath). */
	homeAliases: readonly string[];
	/** Canonical roots; deletion targets must be strictly nested inside one. */
	allowedRoots: readonly string[];
	realpathSync: (target: string) => string;
	existsSync: (target: string) => boolean;
	statUid: (target: string) => number;
	/** Current process uid; `undefined` (win32) skips the ownership check. */
	uid: number | undefined;
	/**
	 * Whether comparisons fold letter case. Windows filesystems are
	 * case-insensitive by construction, so the default world folds there and
	 * only there: darwin case sensitivity is per-volume, and one volume's
	 * evidence (e.g. temp storage) never authorizes folding on another volume.
	 */
	caseInsensitive: boolean;
}

function pathKit(pathModule: PlatformPath, caseInsensitive: boolean) {
	const norm = (value: string): string => {
		const normalized = pathModule.normalize(value);
		return caseInsensitive ? normalized.toLowerCase() : normalized;
	};
	const withSeparator = (value: string): string =>
		value.endsWith(pathModule.sep) ? value : value + pathModule.sep;
	return {
		equal: (a: string, b: string): boolean => norm(a) === norm(b),
		/** `ancestor` is `descendant` itself or a path-segment prefix of it. */
		isAncestorOrEqual: (ancestor: string, descendant: string): boolean => {
			const a = norm(ancestor);
			const d = norm(descendant);
			return a === d || d.startsWith(withSeparator(a));
		},
		/** `child` is strictly below `root` (never the root itself). */
		strictlyInside: (child: string, root: string): boolean => {
			const c = norm(child);
			const r = norm(root);
			return c !== r && c.startsWith(withSeparator(r));
		},
		segments: (value: string): string[] => {
			const root = pathModule.parse(pathModule.normalize(value)).root;
			const relative = pathModule.relative(root, pathModule.normalize(value));
			return relative === "" ? [] : relative.split(pathModule.sep).filter((part: string) => part !== "");
		},
		/** Every existing component strictly below `root`, deepest last. */
		componentsBetween: (root: string, target: string): string[] => {
			const parts = pathModule
				.relative(pathModule.normalize(root), pathModule.normalize(target))
				.split(pathModule.sep)
			.filter((part: string) => part !== "" && part !== ".");
			const components: string[] = [];
			let current = pathModule.normalize(root);
			for (const part of parts) {
				current = pathModule.join(current, part);
				components.push(current);
			}
			return components;
		},
	};
}

function tryRun<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

/**
 * The single verdict every recursive deletion must pass.
 *
 * Ordering is fail-closed: purely lexical refusals (empty/relative/root/
 * shallow/home) fire before any filesystem access, so even an unreadable or
 * racing path can never slip through on a technicality.
 */
export function assessDeletionTarget(target: string, world: SafeCleanupWorld): DeletionVerdict {
	const kit = pathKit(world.pathModule, world.caseInsensitive);
	const refuse = (reason: DeletionRefusalReason, message: string): DeletionRefusal => ({
		ok: false,
		reason,
		message,
		target,
	});

	if (typeof target !== "string" || target.trim() === "") {
		return refuse("empty-target", "refusing to delete: target is empty or blank");
	}
	if (!world.pathModule.isAbsolute(target)) {
		return refuse(
			"relative-target",
			`refusing to delete relative target ${JSON.stringify(target)}: relative paths are ambiguous under process.cwd()`,
		);
	}
	const resolved = world.pathModule.resolve(target);
	if (kit.equal(resolved, world.pathModule.parse(resolved).root)) {
		return refuse("filesystem-root", `refusing to delete the filesystem root (${resolved})`);
	}
	// Home checks precede the shallow check on purpose: `/home` (or `C:\Users`)
	// is both a one-segment path and an ancestor of the real home, and the
	// home-specific reason is the actionable one.
	for (const home of world.homeAliases) {
		if (kit.equal(resolved, home)) {
			return refuse("real-home", `refusing to delete the real home directory (${home})`);
		}
		if (kit.isAncestorOrEqual(resolved, home)) {
			return refuse(
				"real-home-ancestor",
				`refusing to delete ${resolved}: it contains the real home directory (${home})`,
			);
		}
	}
	if (kit.segments(resolved).length < 2) {
		return refuse(
			"too-shallow",
			`refusing to delete ${resolved}: fewer than 2 path segments below the filesystem root`,
		);
	}
	// Each declared root is a boundary, never a deletion target. This must run
	// before broader-root containment: a worktree under /tmp is both an exact
	// repository root and strictly inside the OS temp root.
	if (world.allowedRoots.some(root => kit.equal(resolved, root))) {
		return refuse("outside-allowed-roots", `refusing to delete allowed root ${resolved}`);
	}

	const exists = (() => {
		try {
			return world.existsSync(resolved);
		} catch {
			return true; // unreadable → treat as existing so the strict path runs
		}
	})();
	let canonical: string;
	if (exists) {
		const real = tryRun(() => world.realpathSync(resolved));
		if (real === undefined) {
			return refuse(
				"symlink-escape",
				`refusing to delete ${resolved}: it exists but its real path could not be resolved`,
			);
		}
		canonical = real;
	} else {
		// Absent targets are a no-op for `force` removals; the lexical checks
		// above have already run, which is all that can be checked offline.
		canonical = resolved;
	}

	if (exists) {
		for (const home of world.homeAliases) {
			if (kit.equal(canonical, home)) {
				return refuse(
					"real-home",
					`refusing to delete ${resolved}: it resolves to the real home directory (${home})`,
				);
			}
			if (kit.isAncestorOrEqual(canonical, home)) {
				return refuse(
					"real-home-ancestor",
					`refusing to delete ${resolved}: it resolves to ${canonical}, which contains the real home directory (${home})`,
				);
			}
		}
		if (kit.equal(canonical, world.pathModule.parse(canonical).root)) {
			return refuse("filesystem-root", `refusing to delete ${resolved}: it resolves to the filesystem root`);
		}
		if (kit.segments(canonical).length < 2) {
			return refuse(
				"too-shallow",
				`refusing to delete ${resolved}: it resolves to a path with fewer than 2 segments below the root`,
			);
		}
		if (world.allowedRoots.some(root => kit.equal(canonical, root))) {
			return refuse("outside-allowed-roots", `refusing to delete ${resolved}: it resolves to allowed root ${canonical}`);
		}
	}

	const lexicalRoot = world.allowedRoots.find((root) => kit.strictlyInside(resolved, root));
	if (exists) {
		const canonicalRoot = world.allowedRoots.find((root) => kit.strictlyInside(canonical, root));
		// An explicitly registered, process-created fixture root outside the
		// standard roots (see registerOwnedDeletionRoot) is the only additional
		// permission surface; it never relaxes the home/ancestor/root/shallow
		// checks above and still requires process ownership below.
		const grantedRoot = canonicalRoot ? undefined : grantedRootFor(resolved, canonical);
		const effectiveRoot = canonicalRoot ?? grantedRoot;
		if (!effectiveRoot) {
			return lexicalRoot
				? refuse(
						"symlink-escape",
						`refusing to delete ${resolved}: it resolves to ${canonical}, outside every allowed root (${world.allowedRoots.join(", ")})`,
					)
				: refuse(
						"outside-allowed-roots",
						`refusing to delete ${resolved}: it is not strictly inside any allowed root (${world.allowedRoots.join(", ")})`,
					);
		}
		if (world.uid !== undefined) {
			for (const component of kit.componentsBetween(effectiveRoot, canonical)) {
				const owner = tryRun(() => world.statUid(component));
				if (owner === undefined) {
					return refuse(
						"unowned-path",
						`refusing to delete ${canonical}: ownership of ${component} could not be verified`,
					);
				}
				if (owner !== world.uid) {
					return refuse(
						"unowned-path",
						`refusing to delete ${canonical}: ${component} is owned by uid ${owner}, not the test process uid ${world.uid}`,
					);
				}
			}
		}
		return { ok: true, target, canonicalTarget: canonical, containedRoot: effectiveRoot };
	}
	if (!lexicalRoot) {
		return refuse(
			"outside-allowed-roots",
			`refusing to delete ${resolved}: it is not strictly inside any allowed root (${world.allowedRoots.join(", ")})`,
		);
	}
	return { ok: true, target, canonicalTarget: canonical, containedRoot: lexicalRoot };
}

function homeAliasesFor(home: string): string[] {
	const aliases = new Set<string>([path.normalize(home)]);
	const real = tryRun(() => fs.realpathSync(home));
	if (real !== undefined) aliases.add(real);
	return [...aliases];
}

function usableAccountHome(home: string | undefined): string | undefined {
	if (!home || !path.isAbsolute(home)) return undefined;
	const resolved = path.resolve(home);
	return resolved === path.parse(resolved).root ? undefined : resolved;
}

function accountHomeIndependentOfEnvironment(): string | undefined {
	try {
		if (process.platform === "linux") {
			const uid = process.geteuid?.();
			if (uid === undefined) return undefined;
			const result = Bun.spawnSync({
				cmd: ["getent", "passwd", String(uid)],
				env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "ignore",
			});
			if (result.exitCode !== 0) return undefined;
			return usableAccountHome(new TextDecoder().decode(result.stdout).split("\n")[0]?.split(":")[5]);
		}
		if (process.platform === "darwin") {
			const username = os.userInfo().username;
			const result = Bun.spawnSync({
				cmd: ["dscl", ".", "-read", `/Users/${username}`, "NFSHomeDirectory"],
				env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "ignore",
			});
			if (result.exitCode !== 0) return undefined;
			const line = new TextDecoder().decode(result.stdout).split("\n").find(entry => entry.startsWith("NFSHomeDirectory:"));
			return usableAccountHome(line?.slice("NFSHomeDirectory:".length).trim());
		}
		return usableAccountHome(os.userInfo().homedir);
	} catch {
		return undefined;
	}
}

/**
 * Case folding authority for the default world.
 *
 * Windows filesystems are case-insensitive by construction, so folding is
 * correct there. On darwin, case sensitivity is a per-volume property
 * (case-sensitive APFS is a supported format): a probe of one volume — the
 * temp storage — proves nothing about any other volume, so platform-wide
 * folding is unsound as positive-containment authority. On a case-sensitive
 * volume, folding `~/Tmp` onto an existing `~/tmp` tree would authorize
 * deleting unrelated user data (PR #4821 review at 61bbac07). Existing paths
 * are instead compared as exact canonical (realpath) values everywhere but
 * win32; the realpath of an existing directory is authoritative on both
 * case-sensitive and case-insensitive volumes.
 */
/** Test-visible: the win32-only case-folding authority rule (see above). */
export function caseFoldingForPlatform(): boolean {
	return process.platform === "win32";
}

function deletionRootsFor(homeAliases: readonly string[], caseInsensitive: boolean): string[] {
	const kit = pathKit(path, caseInsensitive);
	const candidates = [
		tryRun(() => fs.realpathSync(os.tmpdir())) ?? path.resolve(os.tmpdir()),
		"/tmp",
		"/var/tmp",
		...(process.platform === "darwin" ? ["/private/tmp", "/private/var/tmp"] : []),
	];
	const roots = new Set<string>();
	for (const candidate of candidates) {
		const root = tryRun(() => fs.realpathSync(path.resolve(candidate))) ?? path.resolve(candidate);
		if (!fs.existsSync(root)) continue;
		// Never treat a root that contains the real home, or lives inside it, as a
		// standard cleanup root. This prevents hostile HOME/TMPDIR combinations
		// from making a real-home child look like an owned temp fixture.
		if (homeAliases.some(home => kit.isAncestorOrEqual(root, home) || kit.isAncestorOrEqual(home, root))) continue;
		roots.add(root);
	}
	return [...roots];
}

/**
 * The default world. Built eagerly at module load — before any test or script
 * mutates `process.env.HOME`. The account-backed resolver supplies the REAL
 * operator home independently of mutable HOME/TMPDIR values; if that evidence
 * is unavailable, no standard cleanup roots are authorized.
 */
const defaultWorld: SafeCleanupWorld = (() => {
	const caseInsensitive = caseFoldingForPlatform();
	const trustedHome = accountHomeIndependentOfEnvironment();
	const aliases = trustedHome ? new Set(homeAliasesFor(path.resolve(trustedHome))) : new Set<string>();
	const repoRoot = tryRun(() => fs.realpathSync(path.join(import.meta.dir, ".."))) ?? path.resolve(
		import.meta.dir,
		"..",
	);
	return {
		pathModule: path,
		homeAliases: [...aliases],
		allowedRoots: trustedHome ? [...deletionRootsFor([...aliases], caseInsensitive), repoRoot] : [repoRoot],
		realpathSync: (target) => fs.realpathSync(target),
		existsSync: (target) => fs.existsSync(target),
		statUid: (target) => fs.statSync(target).uid,
		uid: process.platform === "win32" ? undefined : process.getuid?.(),
		caseInsensitive,
	};
})();

export function getDefaultSafeCleanupWorld(): SafeCleanupWorld {
	return defaultWorld;
}

// --- Explicitly granted test-owned deletion roots ---------------------------------
//
// A small class of tests must create fixtures under the REAL home (trusted
// user-scope resolution only honors the real home — mocking os.homedir cannot
// redirect it, because resolvers capture the binding at import time). Those
// tests still must not get blanket permission to recursively delete anything
// under the home: they register the exact directory they are about to create,
// the verdict accepts only that directory (and its nested contents), and the
// home itself, its ancestors, and every unregistered sibling stay refused.

const grantedOwnedRoots = new Map<string, number>();

/**
 * Grant this test process permission to recursively delete exactly `dir`
 * (and its contents). Must be called BEFORE the directory is created; the
 * registration is refused for the real home, an ancestor of it, relative
 * paths, and paths that already exist (a fresh, process-owned fixture).
 * Returns a disposer that forgets the grant.
 */
export function registerOwnedDeletionRoot(dir: string): () => void {
	// The grant's case authority is the verdict world's own evidence (win32
	// only). It must never fold case on darwin: on case-sensitive APFS a
	// missing `~/Tmp` grant must not cover the existing `~/tmp` tree (PR #4821
	// review at 61bbac07).
	const kit = pathKit(path, defaultWorld.caseInsensitive);
	const resolved = path.resolve(dir);
	if (!path.isAbsolute(dir)) throw new Error(`registerOwnedDeletionRoot: relative path ${JSON.stringify(dir)}`);
	for (const home of defaultWorld.homeAliases) {
		if (kit.equal(resolved, home) || kit.isAncestorOrEqual(resolved, home)) {
			throw new Error(`registerOwnedDeletionRoot: ${resolved} is the real home or an ancestor of it`);
		}
	}
	if (fs.existsSync(resolved)) {
		throw new Error(`registerOwnedDeletionRoot: ${resolved} already exists; grant before creating`);
	}
	grantedOwnedRoots.set(resolved, Date.now());
	return () => {
		grantedOwnedRoots.delete(resolved);
	};
}

function grantedRootFor(resolved: string, canonical: string): string | undefined {
	if (grantedOwnedRoots.size === 0) return undefined;
	const kit = pathKit(path, defaultWorld.caseInsensitive);
	for (const granted of grantedOwnedRoots.keys()) {
		// The granted root itself and everything strictly below it are deletable;
		// every other path — siblings, parents, the home — stays refused.
		const covered = (candidate: string): boolean =>
			kit.equal(candidate, granted) || kit.strictlyInside(candidate, granted);
		if (covered(resolved) || covered(canonical)) return granted;
	}
	return undefined;
}

/** Thrown by `safeRm*`/`assertSafeDeletion` so refusals surface as test errors. */
export class SafeCleanupRefusalError extends Error {
	public readonly refusal: DeletionRefusal;
	constructor(refusal: DeletionRefusal) {
		super(refusal.message);
		this.name = "SafeCleanupRefusalError";
		this.refusal = refusal;
	}
}

export function assertSafeDeletion(target: string, world: SafeCleanupWorld = defaultWorld): DeletionApproval {
	const verdict = assessDeletionTarget(target, world);
	if (!verdict.ok) throw new SafeCleanupRefusalError(verdict);
	return verdict;
}

// Pristine function references, captured at module load. `safeRm*` must not be
// affected by (or re-enter) the runtime guard installed below.
const originalRmSync = fs.rmSync.bind(fs);
const originalRm = fs.promises.rm.bind(fs.promises);

/**
 * Safe recursive cleanup. Identical semantics to
 * `fs.rmSync(target, options)` for permitted targets; refuses (throws) when the
 * verdict fails. Works in any process — no preload required.
 */
export function safeRmSync(target: string, options?: fsTypes.RmOptions): void {
	assertSafeDeletion(target);
	originalRmSync(target, options);
}

/** Promise variant of {@link safeRmSync} (`fs.promises.rm`). */
export async function safeRm(target: string, options?: fsTypes.RmOptions): Promise<void> {
	assertSafeDeletion(target);
	await originalRm(target, options);
}

export interface DeletionGuardOptions {
	world?: SafeCleanupWorld;
	/** Default: print to stderr and abort the process (exit 70). */
	onViolation?: (refusal: DeletionRefusal, target: string) => void;
	label?: string;
}

function coerceTarget(target: unknown): string | null {
	if (typeof target === "string") return target;
	if (Buffer.isBuffer(target)) return target.toString("utf8");
	if (target instanceof URL) {
		try {
			return decodeURIComponent(target.pathname);
		} catch {
			return null;
		}
	}
	return null;
}

const GUARD_INSTALLED = Symbol.for("gajae-code.safe-cleanup.deletion-guard");

type SyncRmLike = (target: unknown, options?: fsTypes.RmOptions) => unknown;
type AsyncRmLike = (target: unknown, options?: fsTypes.RmOptions) => Promise<unknown>;

/**
 * Install the runtime recursive-deletion guard in this test process.
 *
 * Intercepted (verified against Bun 1.4.0, pinned by tests):
 * - `fs.promises.rm` / `fs.promises.rmdir` — the `promises` object is shared
 *   by reference across every import style, including `import * as fs`.
 * - `require("node:fs")` and `require("node:fs/promises")` exports (CJS
 *   consumers, including third-party dependencies).
 *
 * NOT interceptable in Bun 1.4.0: top-level `fs.rmSync`/`fs.rm`/
 * `fs.rmdirSync`/`fs.rmdir` reached through ESM namespace or named imports —
 * those bindings are immutable snapshots. `scripts/check-unsafe-rmrf.ts`
 * closes that gap statically for repository test code.
 */
export function installRuntimeDeletionGuard(options: DeletionGuardOptions = {}): void {
	const registry = globalThis as Record<symbol, unknown>;
	if (registry[GUARD_INSTALLED]) return;
	registry[GUARD_INSTALLED] = true;

	const world = options.world ?? defaultWorld;
	const label = options.label ?? "bun-test";
	const onViolation =
		options.onViolation ??
		((refusal: DeletionRefusal, target: string): void => {
			process.stderr.write(
				[
					`[safe-cleanup:${label}] REFUSED recursive deletion of ${target} (${refusal.reason})`,
					`[safe-cleanup:${label}] ${refusal.message}`,
					`[safe-cleanup:${label}] aborting process: recursive test cleanup must never leave the allowed roots (issue #4794)`,
					"",
				].join("\n"),
			);
			process.exit(70);
		});

	const refusalFor = (target: unknown): DeletionRefusal | null => {
		const asString = coerceTarget(target);
		if (asString === null) return null;
		const verdict = assessDeletionTarget(asString, world);
		return verdict.ok ? null : verdict;
	};
	// Argument-preserving wrapper: CJS `rm`/`rmdir` accept a callback as the
	// third argument, and callers may pass extra args; the wrapper must forward
	// every argument untouched or approved calls would throw ERR_INVALID_ARG_TYPE.
	const guardVariadic =
		(original: (...args: never[]) => unknown) =>
		(...args: never[]): unknown => {
			const options = args[1] as fsTypes.RmOptions | undefined;
			if (options?.recursive === true) {
				const refusal = refusalFor(args[0]);
				if (refusal) {
					onViolation(refusal, refusal.target);
					// Fail closed even when a custom handler returns: never fall
					// through to the original deletion after a refusal.
					throw new SafeCleanupRefusalError(refusal);
				}
			}
			return original(...args);
		};
	const guardAsync =
		(original: AsyncRmLike) =>
		async (target: unknown, options?: fsTypes.RmOptions): Promise<unknown> => {
			if (options?.recursive === true) {
				const refusal = refusalFor(target);
				if (refusal) {
					onViolation(refusal, refusal.target);
					throw new SafeCleanupRefusalError(refusal);
				}
			}
			return original(target, options);
		};

	// Shared `fs.promises` object — reachable from every import style.
	const promises = fs.promises as unknown as Record<string, AsyncRmLike>;
	const patches: GuardPatch[] = [
		{ holder: promises, name: "rm", original: promises.rm, wrapped: guardAsync(promises.rm.bind(promises)) },
		{
			holder: promises,
			name: "rmdir",
			original: promises.rmdir,
			wrapped: guardAsync(promises.rmdir.bind(promises)),
		},
	];

	// CJS export objects — mutable, and what `require()` hands to consumers.
	const require = createRequire(import.meta.url);
	const cfs = require("node:fs") as Record<string, SyncRmLike>;
	for (const name of ["rmSync", "rm", "rmdirSync", "rmdir"] as const) {
		patches.push({
			holder: cfs,
			name,
			original: cfs[name],
			wrapped: guardVariadic((cfs[name] as (...args: never[]) => unknown).bind(cfs)),
		});
	}
	const cfp = require("node:fs/promises") as Record<string, AsyncRmLike>;
	patches.push({ holder: cfp, name: "rm", original: cfp.rm, wrapped: guardAsync(cfp.rm.bind(cfp)) });
	patches.push({ holder: cfp, name: "rmdir", original: cfp.rmdir, wrapped: guardAsync(cfp.rmdir.bind(cfp)) });

	for (const patch of patches) patch.holder[patch.name] = patch.wrapped;
	installedPatches = patches;
}

interface GuardPatch {
	holder: Record<string, unknown>;
	name: string;
	original: unknown;
	wrapped: unknown;
}

let installedPatches: GuardPatch[] = [];

/** Test-only: restore the pristine deletion functions and allow reinstall. */
export function __uninstallRuntimeDeletionGuardForTests(): void {
	const registry = globalThis as Record<symbol, unknown>;
	registry[GUARD_INSTALLED] = undefined;
	for (const patch of installedPatches) patch.holder[patch.name] = patch.original;
	installedPatches = [];
}
