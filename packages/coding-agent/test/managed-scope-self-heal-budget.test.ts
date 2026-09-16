import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	drainDeferredOwnerOnlySelfHeals,
	OWNER_ONLY_SELF_HEAL_MAX_ENTRIES,
	pendingDeferredOwnerOnlyRepairFailureCount,
	pendingDeferredOwnerOnlySelfHealCount,
	pendingDeferredOwnerOnlyTraversalFailureCount,
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
	selfHealOwnerOnlyModeDrift,
} from "../src/session/internal/managed-session-scope";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	// Let any scheduled background self-heal settle against the still-present tree
	// before we remove it, so a truncated-walk test never leaks work into the next.
	await drainDeferredOwnerOnlySelfHeals();
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function isOwnerOnly(pathname: string): boolean {
	return (fs.lstatSync(pathname).mode & 0o077) === 0;
}

/**
 * A managed-scope directory to run the self-heal walk against directly. Prepare
 * only invokes the walk when a retained directory authority exists (Linux-only),
 * so exercising `selfHealOwnerOnlyModeDrift` against a real tree is how the walk,
 * its targeted repair, and its deferred tail are covered on every platform.
 */
function tempTree(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-selfheal-tree-"));
	temporaryDirectories.push(root);
	return root;
}

function fixture(): { cwd: string; agentDir: string; sessionsRoot: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-selfheal-home-"));
	temporaryDirectories.push(home);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-selfheal-cwd-"));
	temporaryDirectories.push(cwd);
	const agentDir = path.join(home, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
	return { cwd, agentDir, sessionsRoot };
}

function scopeFor(input: { cwd: string; agentDir: string; sessionsRoot: string }) {
	const resolved = resolveManagedScope(input);
	if (resolved.kind !== "resolved") throw new Error(`resolve failed: ${resolved.code}`);
	return resolved.scope;
}

/** Fill the scope tree with far more owner-only descendants than the walk budget. */
function populateLargeTree(directory: string, entries: number): void {
	const perDir = 200;
	let created = 0;
	let bucket = 0;
	while (created < entries) {
		const dir = path.join(directory, `blob-${bucket}`);
		fs.mkdirSync(dir, { mode: 0o700 });
		created += 1;
		for (let i = 0; i < perDir && created < entries; i += 1) {
			fs.writeFileSync(path.join(dir, `${i}.bin`), "", { mode: 0o600 });
			created += 1;
		}
		bucket += 1;
	}
}

// The managed-scope prepare self-heal walk (`assertOwnerOnlyModesRecursive`) used
// to `lstat` every descendant of the `v2-<cwd>` tree on every session create. On a
// large `~/.gjc` that made ACP `session/new` take ~16s and blow past paseo's spawn
// timeout (#5565). The walk is now budgeted, so its cost is bounded by the budget
// rather than by the on-disk size of the scope tree.
describe.skipIf(process.platform === "win32")("managed scope owner-only self-heal budget", () => {
	it("does not lstat the whole scope tree on prepare when it far exceeds the budget", () => {
		const input = fixture();

		// First prepare succeeds and establishes the retained authority that gates
		// the self-heal walk on subsequent prepares.
		const first = prepareManagedSessionScopeForWriteSync(scopeFor(input));
		expect(first.kind).toBe("resolved");
		if (first.kind !== "resolved") return;

		const scopeDirectory = first.scope.directoryPath;
		const treeEntries = OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 4000;
		populateLargeTree(scopeDirectory, treeEntries);

		// Count only lstats aimed at descendants of the scope directory: the walk is
		// the sole heavy source, so a bounded count proves it early-exited instead of
		// scanning the whole tree.
		const scopePrefix = `${path.resolve(scopeDirectory)}${path.sep}`;
		let scopedLstats = 0;
		const realLstat = fs.lstatSync.bind(fs) as (...args: Parameters<typeof fs.lstatSync>) => unknown;
		vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
			if (path.resolve(String(args[0])).startsWith(scopePrefix)) scopedLstats += 1;
			return realLstat(...args);
		}) as typeof fs.lstatSync);

		const second = prepareManagedSessionScopeForWriteSync(scopeFor(input));
		expect(second.kind).toBe("resolved");

		// A full walk would lstat every one of the `treeEntries` descendants; the
		// budgeted walk stops at (at most) the entry budget plus a small margin for
		// the non-walk stats the prepare performs on the scope root itself.
		expect(scopedLstats).toBeLessThanOrEqual(OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 256);
		expect(scopedLstats).toBeLessThan(treeEntries);
	});

	// Finding 1: a truncated synchronous scan is NOT a proven owner-only tree. A
	// descendant beyond the scan prefix that drifted group/other-readable must not
	// be silently accepted; the deferred background self-heal has to finish the
	// tail and restore the contract.
	it("repairs drift beyond the scan budget via a deferred background self-heal", async () => {
		const root = tempTree();

		// >budget direct children in the root guarantees the budgeted walk exhausts
		// before it ever descends into a subdirectory — regardless of readdir order
		// — so `tail/` (and its drifted file) is provably unscanned synchronously.
		for (let i = 0; i < OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 2000; i += 1) {
			fs.writeFileSync(path.join(root, `pad-${i}.bin`), "", { mode: 0o600 });
		}
		const tail = path.join(root, "tail");
		fs.mkdirSync(tail, { mode: 0o700 });
		const driftedFile = path.join(tail, "leaked.bin");
		fs.writeFileSync(driftedFile, "secret", { mode: 0o600 });
		fs.chmodSync(driftedFile, 0o644);
		expect(isOwnerOnly(driftedFile)).toBe(false);

		selfHealOwnerOnlyModeDrift(root, "default");

		// The synchronous walk returned without scanning the tail: the drift is
		// still present, and a deferred repair was queued rather than dropped.
		expect(isOwnerOnly(driftedFile)).toBe(false);
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);

		// Once the background self-heal drains, the owner-only contract holds again.
		await drainDeferredOwnerOnlySelfHeals();
		expect(isOwnerOnly(driftedFile)).toBe(true);
	});

	// Finding 2: enumeration itself must be bounded. A flat high-fan-out directory
	// must never be fully materialized (`readdirSync`) by the walk — it is streamed
	// with `opendir` and stops at the budget.
	it("streams a high-fan-out directory instead of materializing it", () => {
		const root = tempTree();
		const flat = path.join(root, "flat");
		fs.mkdirSync(flat, { mode: 0o700 });
		const fanOut = OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 12000;
		for (let i = 0; i < fanOut; i += 1) {
			fs.writeFileSync(path.join(flat, `entry-${i}.bin`), "", { mode: 0o600 });
		}
		const resolvedFlat = path.resolve(flat);
		const rootPrefix = `${path.resolve(root)}${path.sep}`;

		const readdirTargets: string[] = [];
		const realReaddir = fs.readdirSync.bind(fs) as (...args: Parameters<typeof fs.readdirSync>) => unknown;
		vi.spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
			readdirTargets.push(path.resolve(String(args[0])));
			return realReaddir(...args);
		}) as typeof fs.readdirSync);

		let scopedLstats = 0;
		const realLstat = fs.lstatSync.bind(fs) as (...args: Parameters<typeof fs.lstatSync>) => unknown;
		vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
			if (path.resolve(String(args[0])).startsWith(rootPrefix)) scopedLstats += 1;
			return realLstat(...args);
		}) as typeof fs.lstatSync);

		selfHealOwnerOnlyModeDrift(root, "default");

		// The walk never materializes the flat directory (no `readdirSync` on it),
		// and its per-entry stats stay bounded by the budget even though the
		// directory is far larger.
		expect(readdirTargets).not.toContain(resolvedFlat);
		expect(scopedLstats).toBeGreaterThan(0);
		expect(scopedLstats).toBeLessThanOrEqual(OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 256);
		expect(scopedLstats).toBeLessThan(fanOut);
	});

	// Finding 3 (and the non-blocking observation): in-budget drift is inspected
	// and repaired, but the repair is targeted — only the drifted descendant is
	// re-secured, never the whole scope.
	it("repairs only the drifted descendant found in-budget, not the whole scope", () => {
		const root = tempTree();
		const nested = path.join(root, "small");
		fs.mkdirSync(nested, { mode: 0o700 });
		const clean = ["a.bin", "b.bin", "c.bin"].map(name => path.join(nested, name));
		for (const pathname of clean) fs.writeFileSync(pathname, "clean", { mode: 0o600 });
		const drifted = path.join(nested, "bad.bin");
		fs.writeFileSync(drifted, "leaked", { mode: 0o600 });
		fs.chmodSync(drifted, 0o644);

		// Count lstats per path. A targeted repair inspects every descendant exactly
		// once (detection) and only re-lstats the drifted file when re-securing it; a
		// full-scope re-secure would re-traverse and lstat the clean siblings again.
		const lstatCounts = new Map<string, number>();
		const realLstat = fs.lstatSync.bind(fs) as (...args: Parameters<typeof fs.lstatSync>) => unknown;
		vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
			const key = path.resolve(String(args[0]));
			lstatCounts.set(key, (lstatCounts.get(key) ?? 0) + 1);
			return realLstat(...args);
		}) as typeof fs.lstatSync);

		selfHealOwnerOnlyModeDrift(root, "default");

		// The in-budget drift was inspected and repaired...
		expect(isOwnerOnly(drifted)).toBe(true);
		expect(lstatCounts.get(path.resolve(drifted)) ?? 0).toBeGreaterThanOrEqual(2);
		// ...while each clean sibling was inspected exactly once and never re-secured
		// (targeted repair, not a full re-secure of the entire scope), and no
		// unbounded tail work was deferred.
		for (const pathname of clean) expect(lstatCounts.get(path.resolve(pathname))).toBe(1);
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBe(0);
	});

	// Second review — Finding 1: the walk queues a directory after an `lstat`, then
	// opens it later (after popping/yielding). A same-user concurrent replacement in
	// that window can turn the queued directory into a symlink or a different
	// directory; the walk must revalidate identity (dev+ino) before enumerating and
	// stop on any mismatch, so its owner-only repair can never follow the
	// replacement into descendants outside the retained managed scope.
	it("does not enumerate a queued scope directory whose identity changed before it was opened", async () => {
		const root = tempTree();
		const sub = path.join(root, "sub");
		fs.mkdirSync(sub, { mode: 0o700 });
		const inner = path.join(sub, "leaked.bin");
		fs.writeFileSync(inner, "secret", { mode: 0o600 });
		fs.chmodSync(inner, 0o644);
		expect(isOwnerOnly(inner)).toBe(false);

		// Report a different inode for `sub` on the *revalidating* lstat (the second
		// stat of `sub`, done right before `opendir`) to mimic a concurrent
		// replacement between queueing and opening. The first stat (classification)
		// captures the real identity the revalidation is then compared against.
		const resolvedSub = path.resolve(sub);
		let subLstats = 0;
		const realLstat = fs.lstatSync.bind(fs) as (...args: Parameters<typeof fs.lstatSync>) => fs.Stats;
		vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
			const stat = realLstat(...args);
			if (path.resolve(String(args[0])) === resolvedSub) {
				subLstats += 1;
				if (subLstats >= 2) {
					const swapped = Object.create(stat);
					Object.defineProperty(swapped, "ino", {
						value: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1,
						enumerable: true,
					});
					return swapped;
				}
			}
			return stat;
		}) as typeof fs.lstatSync);

		selfHealOwnerOnlyModeDrift(root, "default");

		// The identity mismatch stopped the walk at `sub`: the drifted file inside the
		// "replaced" directory was never opened or repaired. The subtree under `sub`
		// was therefore left uninspected, so the scan is incomplete and a deferred walk
		// is scheduled rather than the tree being reported clean — it just never
		// enumerates the replacement.
		expect(isOwnerOnly(inner)).toBe(false);
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);

		// Draining with the transient mismatch cleared lets the scheduled deferred walk
		// traverse `sub` for real and repair the descendant, so the case leaves no
		// module-level traversal-failure marker behind for later tests.
		vi.restoreAllMocks();
		await drainDeferredOwnerOnlySelfHeals();
		expect(isOwnerOnly(inner)).toBe(true);
	});

	// Second review — Finding 2: for a descendant past the synchronous budget the
	// deferred tail is the ONLY enforcement step. A repair failure there must not be
	// swallowed while prepare reports success; it is recorded, and the next prepare
	// retries and fails closed until the descendant can actually be secured.
	it("preserves a failed deferred repair and fails closed on the next prepare until it can succeed", async () => {
		const root = tempTree();

		// >budget direct children guarantee the synchronous scan truncates before it
		// ever descends into `tail/`, so the drifted file is only reachable by the
		// deferred background walk.
		for (let i = 0; i < OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 2000; i += 1) {
			fs.writeFileSync(path.join(root, `pad-${i}.bin`), "", { mode: 0o600 });
		}
		const tail = path.join(root, "tail");
		fs.mkdirSync(tail, { mode: 0o700 });
		const driftedFile = path.join(tail, "leaked.bin");
		fs.writeFileSync(driftedFile, "secret", { mode: 0o600 });
		fs.chmodSync(driftedFile, 0o644);
		const resolvedDrift = path.resolve(driftedFile);

		// Force the owner-only repair of the drifted tail file to fail, as an
		// ownership/ACL problem the self-heal cannot fix would.
		const realApply = native.applyOwnerOnlyPathSecurity.bind(native);
		const apply = vi.spyOn(native, "applyOwnerOnlyPathSecurity").mockImplementation(((
			pathname: string,
			kind: "directory" | "file",
		) => {
			if (path.resolve(pathname) === resolvedDrift) return { ok: false, code: "mode_mismatch" };
			return realApply(pathname, kind);
		}) as typeof native.applyOwnerOnlyPathSecurity);

		// Synchronous scan truncates on the pad entries and schedules the deferred tail.
		selfHealOwnerOnlyModeDrift(root, "default");
		await drainDeferredOwnerOnlySelfHeals();

		// The deferred repair failed: the file is still readable and the failure was
		// recorded rather than discarded behind a successful-looking prepare.
		expect(isOwnerOnly(driftedFile)).toBe(false);
		expect(apply).toHaveBeenCalled();
		expect(pendingDeferredOwnerOnlyRepairFailureCount()).toBeGreaterThan(0);

		// The next prepare observes the recorded failure, retries it, and — since the
		// repair still cannot succeed — fails closed instead of reporting success.
		expect(() => selfHealOwnerOnlyModeDrift(root, "default")).toThrow("mode_mismatch");
		expect(pendingDeferredOwnerOnlyRepairFailureCount()).toBeGreaterThan(0);

		// Once the underlying cause clears, the retry succeeds, the record clears, and
		// prepare no longer fails closed.
		apply.mockRestore();
		expect(() => selfHealOwnerOnlyModeDrift(root, "default")).not.toThrow();
		expect(isOwnerOnly(driftedFile)).toBe(true);
		expect(pendingDeferredOwnerOnlyRepairFailureCount()).toBe(0);
	});

	// Third review — Finding 1: a completed deferred walk only proves what the tree
	// looked like when it ran. A managed scope is same-user writable, so new drift
	// can land past the synchronous scan prefix immediately afterwards. A truncated
	// scan must therefore always schedule a fresh walk — suppressing it on elapsed
	// time alone would let prepare report success over an uninspected tail.
	it("detects a tail that drifted right after a completed deferred walk", async () => {
		const root = tempTree();

		// >budget direct children guarantee every synchronous scan truncates before it
		// descends into `tail/`, so the tail is only ever reachable by a deferred walk.
		for (let i = 0; i < OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 2000; i += 1) {
			fs.writeFileSync(path.join(root, `pad-${i}.bin`), "", { mode: 0o600 });
		}
		const tail = path.join(root, "tail");
		fs.mkdirSync(tail, { mode: 0o700 });

		// First prepare truncates, defers, and the walk completes over a clean tail.
		selfHealOwnerOnlyModeDrift(root, "default");
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);
		await drainDeferredOwnerOnlySelfHeals();

		// Drift is introduced beyond the scan prefix right after that completion.
		const driftedFile = path.join(tail, "leaked.bin");
		fs.writeFileSync(driftedFile, "secret", { mode: 0o600 });
		fs.chmodSync(driftedFile, 0o644);
		expect(isOwnerOnly(driftedFile)).toBe(false);

		// The next prepare also truncates, so it must walk the tail again rather than
		// trust the earlier completion over a tree that has since changed.
		selfHealOwnerOnlyModeDrift(root, "default");
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);
		await drainDeferredOwnerOnlySelfHeals();
		expect(isOwnerOnly(driftedFile)).toBe(true);
	});

	// Third review — Finding 2: a walk-level filesystem failure (a failing
	// `Dir.readSync`, not one path's repair) leaves the tail uninspected. It must
	// not be recorded as a completed traversal: that would suppress the retry and
	// let the next prepare report success over a tree the walk never reached.
	it("does not mark the deferred walk complete when the traversal itself fails", async () => {
		const root = tempTree();

		// >budget direct children guarantee the synchronous scan truncates before it
		// descends into `tail/`, so the drift is only reachable by the deferred walk.
		for (let i = 0; i < OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 2000; i += 1) {
			fs.writeFileSync(path.join(root, `pad-${i}.bin`), "", { mode: 0o600 });
		}
		const tail = path.join(root, "tail");
		fs.mkdirSync(tail, { mode: 0o700 });
		const driftedFile = path.join(tail, "leaked.bin");
		fs.writeFileSync(driftedFile, "secret", { mode: 0o600 });
		fs.chmodSync(driftedFile, 0o644);

		// The synchronous scan truncates and schedules the deferred tail walk; only
		// then is the enumeration failure installed, so it hits that walk alone.
		selfHealOwnerOnlyModeDrift(root, "default");
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);
		const opendir = vi.spyOn(fs, "opendirSync").mockImplementation((() => ({
			readSync: () => {
				throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
			},
			closeSync: () => {},
		})) as unknown as typeof fs.opendirSync);
		await drainDeferredOwnerOnlySelfHeals();
		opendir.mockRestore();

		// The walk aborted before traversing the tail: the drift is untouched and the
		// scope is recorded as un-traversed rather than as a completed walk.
		expect(isOwnerOnly(driftedFile)).toBe(false);
		expect(pendingDeferredOwnerOnlyTraversalFailureCount()).toBeGreaterThan(0);

		// The next prepare must not report success over that uninspected tail. Its own
		// synchronous scan truncates on the pads too, so — with a prior aborted
		// traversal recorded — it fails closed instead of accepting the tail, while
		// still scheduling a fresh walk that can clear the failure.
		expect(() => selfHealOwnerOnlyModeDrift(root, "default")).toThrow("mode_mismatch");
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);

		// That scheduled walk now traverses cleanly, repairs the tail, and clears the
		// traversal failure, so a later prepare no longer fails closed.
		await drainDeferredOwnerOnlySelfHeals();
		expect(isOwnerOnly(driftedFile)).toBe(true);
		expect(pendingDeferredOwnerOnlyTraversalFailureCount()).toBe(0);
		expect(() => selfHealOwnerOnlyModeDrift(root, "default")).not.toThrow();
	});

	// Third review — Finding 3: `opendirIfUnchanged` classifies a directory by
	// `lstat`, queues it, and opens it later. A same-user process can replace the
	// queued pathname with a symlink in that window; a check-then-`opendirSync`
	// would follow it and enumerate/repair outside the retained scope. The
	// descriptor-bound no-follow open must refuse the replacement.
	it("refuses to enumerate a queued scope directory swapped to a symlink before it is opened", () => {
		const root = tempTree();
		const sub = path.join(root, "sub");
		fs.mkdirSync(sub, { mode: 0o700 });
		fs.writeFileSync(path.join(sub, "inner.bin"), "clean", { mode: 0o600 });

		// A drifted file entirely outside `root`, reachable only by following a
		// symlink planted at `sub` — the walk over `root` never reaches it otherwise.
		const outside = tempTree();
		const leaked = path.join(outside, "leaked.bin");
		fs.writeFileSync(leaked, "secret", { mode: 0o600 });
		fs.chmodSync(leaked, 0o644);
		expect(isOwnerOnly(leaked)).toBe(false);

		// Swap `sub` (already classified as a real directory) for a symlink to
		// `outside` at the instant the walk opens it, mimicking a concurrent
		// replacement between the classifying stat and the open.
		const resolvedSub = path.resolve(sub);
		let swapped = false;
		const realOpen = fs.openSync.bind(fs) as (...args: Parameters<typeof fs.openSync>) => number;
		vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
			if (!swapped && path.resolve(String(args[0])) === resolvedSub) {
				swapped = true;
				fs.renameSync(sub, `${sub}.moved`);
				fs.symlinkSync(outside, sub);
			}
			return realOpen(...args);
		}) as typeof fs.openSync);

		selfHealOwnerOnlyModeDrift(root, "default");

		// The no-follow open refused the symlink, so the walk never enumerated
		// `outside` through `sub`: its drifted file was neither read nor repaired. That
		// refusal left `sub`'s subtree uninspected, so the scan is incomplete and a
		// deferred walk is scheduled — one that likewise never follows the symlink into
		// `outside`.
		expect(isOwnerOnly(leaked)).toBe(false);
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);
	});

	// Round 4 — Finding 1: a directory the walk queued but then cannot open (its
	// no-follow open fails) leaves that subtree uninspected. The synchronous scan
	// must report incomplete — scheduling the deferred tail walk — rather than
	// skipping the directory and finishing as if the whole tree were owner-only.
	it("treats a sync-walk open failure as incomplete and schedules a deferred walk", async () => {
		const root = tempTree();
		const sub = path.join(root, "sub");
		fs.mkdirSync(sub, { mode: 0o700 });
		const inner = path.join(sub, "leaked.bin");
		fs.writeFileSync(inner, "secret", { mode: 0o600 });
		fs.chmodSync(inner, 0o644);
		expect(isOwnerOnly(inner)).toBe(false);

		// Make `opendirIfUnchanged(sub)` fail its no-follow open so `sub`'s subtree is
		// never enumerated by the synchronous walk (root itself still opens normally).
		const resolvedSub = path.resolve(sub);
		const realOpen = fs.openSync.bind(fs) as (...args: Parameters<typeof fs.openSync>) => number;
		const open = vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
			if (path.resolve(String(args[0])) === resolvedSub)
				throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
			return realOpen(...args);
		}) as typeof fs.openSync);

		selfHealOwnerOnlyModeDrift(root, "default");

		// The open failure left `sub` uninspected: the scan is incomplete, so a deferred
		// walk was scheduled and the drifted descendant inside the unvisited directory
		// was NOT treated as verified (still readable, not repaired synchronously).
		expect(isOwnerOnly(inner)).toBe(false);
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);

		// Once the open failure clears, the deferred walk reaches the tail and repairs
		// it — confirming the scheduled walk really does finish the uninspected subtree.
		open.mockRestore();
		await drainDeferredOwnerOnlySelfHeals();
		expect(isOwnerOnly(inner)).toBe(true);
	});

	// Round 4 — Finding 1 (deferred side): a null open in the background walk leaves
	// the tail it exists to enforce unvisited. It must abort as a traversal failure
	// (never a completed walk), so the next truncated prepare fails closed over that
	// uninspected tail instead of reporting success.
	it("records a traversal failure when the deferred walk cannot open a queued directory", async () => {
		const root = tempTree();

		// >budget direct children guarantee the synchronous scan truncates before it
		// descends into `tail/`, so the tail is only reachable by the deferred walk.
		for (let i = 0; i < OWNER_ONLY_SELF_HEAL_MAX_ENTRIES + 2000; i += 1) {
			fs.writeFileSync(path.join(root, `pad-${i}.bin`), "", { mode: 0o600 });
		}
		const tail = path.join(root, "tail");
		fs.mkdirSync(tail, { mode: 0o700 });
		const driftedFile = path.join(tail, "leaked.bin");
		fs.writeFileSync(driftedFile, "secret", { mode: 0o600 });
		fs.chmodSync(driftedFile, 0o644);

		// The synchronous scan truncates and schedules the deferred tail walk; only then
		// is the open failure installed, so it hits that deferred walk alone.
		selfHealOwnerOnlyModeDrift(root, "default");
		expect(pendingDeferredOwnerOnlySelfHealCount()).toBeGreaterThan(0);
		const resolvedTail = path.resolve(tail);
		const realOpen = fs.openSync.bind(fs) as (...args: Parameters<typeof fs.openSync>) => number;
		const open = vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
			if (path.resolve(String(args[0])) === resolvedTail)
				throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
			return realOpen(...args);
		}) as typeof fs.openSync);
		await drainDeferredOwnerOnlySelfHeals();
		open.mockRestore();

		// The null open aborted the walk before the tail: the drift is untouched and the
		// scope is recorded as un-traversed rather than as a completed walk.
		expect(isOwnerOnly(driftedFile)).toBe(false);
		expect(pendingDeferredOwnerOnlyTraversalFailureCount()).toBeGreaterThan(0);

		// The next prepare truncates on the pads too and, with a prior aborted traversal
		// recorded, fails closed over the uninspected tail while scheduling a fresh walk
		// that can clear the failure.
		expect(() => selfHealOwnerOnlyModeDrift(root, "default")).toThrow("mode_mismatch");
		await drainDeferredOwnerOnlySelfHeals();
		expect(isOwnerOnly(driftedFile)).toBe(true);
		expect(pendingDeferredOwnerOnlyTraversalFailureCount()).toBe(0);
	});
});
