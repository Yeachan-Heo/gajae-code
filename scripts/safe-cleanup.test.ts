import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformPath } from "./safe-cleanup";

import {
	assessDeletionTarget,
	assertSafeDeletion,
	caseFoldingForPlatform,
	getDefaultSafeCleanupWorld,
	registerOwnedDeletionRoot,
	SafeCleanupRefusalError,
	safeRm,
	safeRmSync,
	type DeletionRefusal,
	type DeletionRefusalReason,
	type SafeCleanupWorld,
} from "./safe-cleanup";

interface FakeFs {
	exists: Set<string>;
	realpaths: Map<string, string>;
	owners: Map<string, number>;
}

function makeWorld(
	fake: FakeFs,
	overrides?: {
		pathModule?: PlatformPath;
		homeAliases?: string[];
		allowedRoots?: string[];
		uid?: number | undefined;
		caseInsensitive?: boolean;
	},
): SafeCleanupWorld {
	return {
		pathModule: overrides?.pathModule ?? path.posix,
		homeAliases: overrides?.homeAliases ?? ["/home/op"],
		allowedRoots: overrides?.allowedRoots ?? ["/tmp", "/repo"],
		realpathSync: (target: string): string => {
			const mapped = fake.realpaths.get(target);
			if (mapped !== undefined) return mapped;
			if (fake.exists.has(target)) return target;
			throw new Error(`ENOENT: ${target}`);
		},
		existsSync: (target: string): boolean => fake.exists.has(target) || fake.realpaths.has(target),
		statUid: (target: string): number => fake.owners.get(target) ?? 1000,
		uid: overrides && "uid" in overrides ? overrides.uid : 1000,
		caseInsensitive: overrides?.caseInsensitive ?? false,
	};
}

function baseFake(): FakeFs {
	return {
		exists: new Set([
			"/home/op",
			"/home/op/sub",
			"/home/op/.config",
			"/tmp/owned/child",
			"/tmp/root-owned/child",
			"/repo/checked-out",
			"/opt/elsewhere/thing",
		]),
		realpaths: new Map(),
		owners: new Map([["/tmp/root-owned", 0], ["/tmp/root-owned/child", 0]]),
	};
}

function refusalFor(target: string, world: SafeCleanupWorld): DeletionRefusalReason {
	const verdict = assessDeletionTarget(target, world);
	expect(verdict.ok).toBe(false);
	return (verdict as DeletionRefusal).reason;
}

function approvalFor(target: string, world: SafeCleanupWorld): { canonicalTarget: string; containedRoot: string } {
	const verdict = assessDeletionTarget(target, world);
	expect(verdict.ok).toBe(true);
	if (!verdict.ok) throw new Error("unreachable");
	return { canonicalTarget: verdict.canonicalTarget, containedRoot: verdict.containedRoot };
}

describe("safe-cleanup verdict: lexical refusals (posix)", () => {
	const world = makeWorld(baseFake());

	test("refuses empty and blank targets", () => {
		expect(refusalFor("", world)).toBe("empty-target");
		expect(refusalFor("   ", world)).toBe("empty-target");
	});

	test("refuses relative and dot targets", () => {
		expect(refusalFor("relative/dir", world)).toBe("relative-target");
		expect(refusalFor(".", world)).toBe("relative-target");
		expect(refusalFor("..", world)).toBe("relative-target");
	});

	test("refuses the filesystem root", () => {
		expect(refusalFor("/", world)).toBe("filesystem-root");
		expect(refusalFor("////", world)).toBe("filesystem-root");
	});

	test("refuses single-segment paths as too shallow", () => {
		expect(refusalFor("/x", world)).toBe("too-shallow");
	});

	test("refuses the real home exactly", () => {
		expect(refusalFor("/home/op", world)).toBe("real-home");
		expect(refusalFor("/home/op/", world)).toBe("real-home");
	});

	test("refuses ancestors of the real home", () => {
		expect(refusalFor("/home", world)).toBe("real-home-ancestor");
		expect(refusalFor("/home/", world)).toBe("real-home-ancestor");
	});

	test("refuses dot-dot aliases that resolve into the home", () => {
		expect(refusalFor("/tmp/../../home/op", world)).toBe("real-home");
		expect(refusalFor("/tmp/../..", world)).toBe("filesystem-root");
	});

	test("refuses paths inside the home that are outside the allowed roots", () => {
		expect(refusalFor("/home/op/.config", world)).toBe("outside-allowed-roots");
	});

	test("refuses the allowed roots themselves", () => {
		const deepRootWorld = makeWorld(baseFake(), { allowedRoots: ["/tmp", "/repo/work-tree"] });
		expect(refusalFor("/repo/work-tree", deepRootWorld)).toBe("outside-allowed-roots");
	});

	test("refuses a nested allowed root even when a broader allowed root contains it", () => {
		const nestedRootWorld = makeWorld(baseFake(), { allowedRoots: ["/tmp", "/tmp/repo-worktree"] });
		expect(refusalFor("/tmp/repo-worktree", nestedRootWorld)).toBe("outside-allowed-roots");
	});

	test("refuses whole single-segment roots as too shallow to ever be deletion targets", () => {
		expect(refusalFor("/tmp", world)).toBe("too-shallow");
		expect(refusalFor("/repo", world)).toBe("too-shallow");
	});
});

describe("safe-cleanup verdict: filesystem-aware refusals (posix)", () => {
	test("refuses a symlink that resolves to the real home", () => {
		const fake = baseFake();
		fake.realpaths.set("/tmp/home-link", "/home/op");
		const world = makeWorld(fake);
		expect(refusalFor("/tmp/home-link", world)).toBe("real-home");
	});

	test("refuses a symlink that resolves to an ancestor of the real home", () => {
		const fake = baseFake();
		fake.realpaths.set("/tmp/home-parent-link", "/home");
		const world = makeWorld(fake);
		expect(refusalFor("/tmp/home-parent-link", world)).toBe("real-home-ancestor");
	});

	test("refuses a symlink that escapes the allowed roots", () => {
		const fake = baseFake();
		fake.realpaths.set("/tmp/escape-link", "/opt/elsewhere/thing");
		const world = makeWorld(fake);
		expect(refusalFor("/tmp/escape-link", world)).toBe("symlink-escape");
	});

	test("refuses unowned components below the allowed root", () => {
		const world = makeWorld(baseFake());
		expect(refusalFor("/tmp/root-owned/child", world)).toBe("unowned-path");
	});

	test("refuses components whose ownership cannot be verified", () => {
		const fake = baseFake();
		fake.owners.set("/tmp/owned", 42); // mismatch
		const world = makeWorld(fake);
		expect(refusalFor("/tmp/owned/child", world)).toBe("unowned-path");
	});

	test("skips the ownership check when uid is unavailable (win32-style world)", () => {
		const world = makeWorld(baseFake(), { uid: undefined });
		expect(approvalFor("/tmp/root-owned/child", world).containedRoot).toBe("/tmp");
	});
});

describe("safe-cleanup verdict: approvals (posix)", () => {
	const world = makeWorld(baseFake());

	test("approves an owned path strictly inside the temp root", () => {
		const approval = approvalFor("/tmp/owned/child", world);
		expect(approval.canonicalTarget).toBe("/tmp/owned/child");
		expect(approval.containedRoot).toBe("/tmp");
	});

	test("approves a deeper owned path inside the repository worktree", () => {
		expect(approvalFor("/repo/checked-out/nested/dir", world).containedRoot).toBe("/repo");
	});

	test("approves a missing path strictly inside an allowed root (force no-op)", () => {
		expect(approvalFor("/tmp/owned/gone-already", world).containedRoot).toBe("/tmp");
	});

	test("refuses a missing path outside the allowed roots", () => {
		expect(refusalFor("/var/missing/thing", world)).toBe("outside-allowed-roots");
	});

	test("follows symlinks that stay inside the allowed roots", () => {
		const fake = baseFake();
		fake.realpaths.set("/tmp/link", "/tmp/owned/child");
		const world = makeWorld(fake);
		expect(approvalFor("/tmp/link", world).canonicalTarget).toBe("/tmp/owned/child");
	});
});

describe("safe-cleanup verdict: win32 normalization", () => {
	const fake: FakeFs = {
		exists: new Set([
			"C:\\Users\\Op",
			"C:\\Users\\Op\\AppData\\Local\\Temp\\gjc-home\\agent",
			"D:\\repo\\sub",
			"D:\\other",
		]),
		realpaths: new Map([["C:\\Users\\Op\\AppData\\Local\\Temp\\home-link", "C:\\Users\\Op"]]),
		owners: new Map(),
	};
	const world = makeWorld(fake, {
		pathModule: path.win32,
		homeAliases: ["C:\\Users\\Op"],
		allowedRoots: ["C:\\Users\\Op\\AppData\\Local\\Temp", "D:\\repo"],
		caseInsensitive: true,
	});

	test("refuses the home regardless of case and separator style", () => {
		expect(refusalFor("c:\\users\\op", world)).toBe("real-home");
		expect(refusalFor("C:/Users/Op", world)).toBe("real-home");
		expect(refusalFor("C:\\USERS\\OP\\", world)).toBe("real-home");
	});

	test("refuses win32 ancestors, root, and shallow paths", () => {
		expect(refusalFor("C:\\Users", world)).toBe("real-home-ancestor");
		expect(refusalFor("C:\\", world)).toBe("filesystem-root");
		expect(refusalFor("C:\\x", world)).toBe("too-shallow");
	});

	test("approves owned temp paths case-insensitively", () => {
		expect(approvalFor("c:\\users\\op\\appdata\\local\\temp\\GJC-HOME\\agent", world).containedRoot).toBe(
			"C:\\Users\\Op\\AppData\\Local\\Temp",
		);
	});

	test("refuses other drives outside the allowed roots", () => {
		expect(refusalFor("D:\\other\\thing", world)).toBe("outside-allowed-roots");
		// A single segment below another drive's root is refused by the
		// shallow rule, which fires before containment.
		expect(refusalFor("E:\\anywhere", world)).toBe("too-shallow");
	});

	test("refuses a win32 symlink resolving to the home", () => {
		expect(refusalFor("C:\\Users\\Op\\AppData\\Local\\Temp\\home-link", world)).toBe("real-home");
	});
});

describe("safe-cleanup verdict: world-controlled case folding", () => {
	// Case folding is a property of the injected world (win32 folds; darwin and
	// linux worlds are exact). A darwin world that legitimately KNOWS its
	// volume is case-insensitive may fold for the home refusal; a darwin world
	// without that evidence must not.
	const fake = baseFake();
	fake.exists.add("/Users/Op");
	const foldingWorld = makeWorld(fake, { homeAliases: ["/Users/Op"], allowedRoots: ["/tmp"], caseInsensitive: true });
	const exactWorld = makeWorld(fake, { homeAliases: ["/Users/Op"], allowedRoots: ["/tmp"], caseInsensitive: false });

	test("refuses the home regardless of case when the world folds", () => {
		expect(refusalFor("/users/op", foldingWorld)).toBe("real-home");
		expect(refusalFor("/Users/op/", foldingWorld)).toBe("real-home");
	});

	test("the exact world still refuses the home itself", () => {
		expect(refusalFor("/Users/Op", exactWorld)).toBe("real-home");
	});

	test("an exact world does not fold a case-only sibling of the home onto it", () => {
		fake.exists.add("/Users/op");
		try {
			// The case-only sibling is NOT the home itself: with exact
			// comparison it falls past the home check to containment, where it
			// is refused as outside the allowed roots instead of being folded
			// onto the home alias.
			expect(refusalFor("/Users/op", exactWorld)).toBe("outside-allowed-roots");
			// The home itself is still refused by name, exactly.
			expect(refusalFor("/Users/Op", exactWorld)).toBe("real-home");
		} finally {
			fake.exists.delete("/Users/op");
		}
	});
});

describe("safe-cleanup: darwin case authority (PR #4821 P1 regression)", () => {
	// Deterministic on every platform: the temp-volume probe is gone, so the
	// default world's folding must follow process.platform alone (win32 folds;
	// darwin and linux never fold regardless of any volume's behavior).
	function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		try {
			return run();
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	}

	// NOTE: the default world is built once at module load, so these two
	// platform assertions run against the already-built world. They pin the
	// authority rule on real darwin/win32 hosts and on linux CI; the
	// withPlatform helper exists for the grant/verdict behavior below, which
	// consults the live world per call.
	test.skipIf(process.platform !== "darwin")("default world never folds case on darwin (no temp-volume probe)", () => {
		expect(getDefaultSafeCleanupWorld().caseInsensitive).toBe(false);
	});

	test.skipIf(process.platform !== "win32")("default world folds case on win32", () => {
		expect(getDefaultSafeCleanupWorld().caseInsensitive).toBe(true);
	});

	test("folding authority is win32-only regardless of the live platform (probed at import time)", () => {
		// The removed temp-volume probe made folding volume-dependent at world
		// build time; it must now be a pure platform decision observable on
		// every host: win32 folds, everything else is exact.
		const folding = withPlatform("win32", () => caseFoldingForPlatform());
		const darwinExact = withPlatform("darwin", () => caseFoldingForPlatform());
		const linuxExact = withPlatform("linux", () => caseFoldingForPlatform());
		expect(folding).toBe(true);
		expect(darwinExact).toBe(false);
		expect(linuxExact).toBe(false);
	});

	test.skipIf(process.platform === "win32" || !supportsDistinctCaseOnlySiblings("/var/tmp"))(
		"a missing case-only-sibling grant never authorizes the existing sibling (case-sensitive volume, exact comparison)",
		() => {
			// The exact P1: on case-sensitive APFS (home on its own volume,
			// outside every allowed root), registering a grant for the MISSING
			// `home/Tmp` must never cover the EXISTING `home/tmp` victim tree.
			// The old code folded case in registerOwnedDeletionRoot/grantedRootFor
			// on darwin regardless of volume evidence and approved the victim
			// (containedRoot = the never-created `home/Tmp` grant).
			const homeBase = fs.mkdtempSync(path.join("/var/tmp", "gjc-case-home-"));
			const home = path.join(homeBase, "op");
			const victim = path.join(home, "tmp");
			fs.mkdirSync(path.join(victim, "keep"), { recursive: true });
			fs.writeFileSync(path.join(victim, "keep", "precious.txt"), "do not delete");
			const missingSibling = path.join(home, "Tmp");
			// A darwin world whose evidence is exact (case-sensitive volume):
			// grants fold only when the world folds.
			const world: SafeCleanupWorld = {
				...getDefaultSafeCleanupWorld(),
				homeAliases: [home],
				allowedRoots: ["/tmp", "/var/tmp/gjc-case-allowed"],
				caseInsensitive: false,
			};
			const forget = withPlatform("darwin", () => registerOwnedDeletionRoot(missingSibling));
			try {
				const verdict = assessDeletionTarget(victim, world);
				expect(verdict.ok).toBe(false);
				if (!verdict.ok) expect(verdict.reason).toBe("outside-allowed-roots");
				// Non-destructive proof: the victim tree is untouched.
				expect(fs.existsSync(path.join(victim, "keep", "precious.txt"))).toBe(true);
			} finally {
				forget();
				fs.rmSync(homeBase, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"the granted directory itself is still deletable (grant positives: existing and missing targets)",
		() => {
			const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-case-grant-ok-"));
			const granted = path.join(parent, "Fixture");
			const forget = registerOwnedDeletionRoot(granted);
			try {
				// Missing target: force removal is an approved no-op.
				const missingVerdict = assessDeletionTarget(granted, getDefaultSafeCleanupWorld());
				expect(missingVerdict.ok).toBe(true);
				// Existing target: create then recursively delete through the grant.
				fs.mkdirSync(path.join(granted, "nested"), { recursive: true });
				fs.writeFileSync(path.join(granted, "nested", "f.txt"), "x");
				safeRmSync(granted, { recursive: true, force: true });
				expect(fs.existsSync(granted)).toBe(false);
			} finally {
				forget();
				fs.rmSync(parent, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a granted target resolves through realpath and is deletable (symlink positive)",
		() => {
			const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-case-grant-link-"));
			const granted = path.join(parent, "Target");
			const forget = registerOwnedDeletionRoot(granted);
			fs.mkdirSync(path.join(granted, "data"), { recursive: true });
			fs.writeFileSync(path.join(granted, "data", "f.txt"), "x");
			try {
				const verdict = assessDeletionTarget(granted, getDefaultSafeCleanupWorld());
				expect(verdict.ok && verdict.canonicalTarget === fs.realpathSync(granted)).toBe(true);
				safeRmSync(granted, { recursive: true, force: true });
				expect(fs.existsSync(granted)).toBe(false);
			} finally {
				forget();
				fs.rmSync(parent, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32" || !supportsDistinctCaseOnlySiblings(os.tmpdir()))(
		"an existing case-only sibling under an allowed temp root stays deletable (existing-path positive, exact canonical comparison)",
		() => {
			// Positive containment keeps working for genuinely owned paths even
			// when a case-only sibling exists: the verdict compares the exact
			// canonical value, which is what the process owns.
			const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-case-owned-"));
			const lower = path.join(parent, "victim");
			const upper = path.join(parent, "Victim");
			fs.mkdirSync(path.join(lower, "data"), { recursive: true });
			fs.mkdirSync(path.join(upper, "data"), { recursive: true });
			try {
				safeRmSync(lower, { recursive: true, force: true });
				expect(fs.existsSync(lower)).toBe(false);
				expect(fs.existsSync(upper)).toBe(true);
			} finally {
				fs.rmSync(parent, { recursive: true, force: true });
			}
		},
	);
});

describe("safe-cleanup against the live filesystem", () => {
	test.skipIf(process.platform === "win32")(
		"safeRmSync removes an owned temp tree and its nested children",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-safe-cleanup-pos-"));
			fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
			fs.writeFileSync(path.join(root, "a", "b", "file.txt"), "x");
			safeRmSync(path.join(root, "a"), { recursive: true, force: true });
			expect(fs.existsSync(path.join(root, "a"))).toBe(false);
			await safeRm(root, { recursive: true, force: true });
			expect(fs.existsSync(root)).toBe(false);
		},
	);

	test.skipIf(process.platform === "win32")("safeRm refuses the real home without touching it", () => {
		const home = os.homedir();
		expect(() => safeRmSync(home, { recursive: true, force: true })).toThrow(SafeCleanupRefusalError);
		// Non-destructive proof: the home directory still exists after the refusal.
		expect(fs.existsSync(home)).toBe(true);
	});

	test.skipIf(process.platform === "win32")("safeRm refuses a symlink that resolves to the real home", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-safe-cleanup-link-"));
		const link = path.join(root, "home-link");
		fs.symlinkSync(os.homedir(), link, "dir");
		try {
			expect(() => safeRmSync(link, { recursive: true, force: true })).toThrow(SafeCleanupRefusalError);
			// Read-only probe only: the real home is intact.
			expect(fs.existsSync(os.homedir())).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")("safeRm refuses the repository worktree root itself", () => {
		const repoRoot = path.join(import.meta.dir, "..");
		expect(() => assertSafeDeletion(repoRoot)).toThrow(SafeCleanupRefusalError);
	});

	test.skipIf(process.platform === "win32" || !isWritable("/var/tmp"))(
		"safeRm refuses a symlink that escapes the allowed roots",
		() => {
			const escapeTarget = os.homedir();
			const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-safe-cleanup-wrap-"));
			const link = path.join(tmpRoot, "escape-link");
			fs.symlinkSync(escapeTarget, link, "dir");
			try {
				expect(() => safeRmSync(link, { recursive: true, force: true })).toThrow(SafeCleanupRefusalError);
				expect(fs.existsSync(escapeTarget)).toBe(true);
			} finally {
				fs.rmSync(tmpRoot, { recursive: true, force: true });
			}
		},
	);

	test("refusal error carries the machine-readable reason", () => {
		try {
			assertSafeDeletion("");
			throw new Error("expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(SafeCleanupRefusalError);
			expect((error as SafeCleanupRefusalError).refusal.reason).toBe("empty-target");
		}
	});
});

describe("registerOwnedDeletionRoot grants", () => {
	test.skipIf(process.platform === "win32")("permits exactly the granted process-created directory", () => {
		const dir = path.join(os.homedir(), `.gjc-grant-test-${process.pid}-${Date.now()}`);
		const forget = registerOwnedDeletionRoot(dir);
		fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
		try {
			const verdict = assessDeletionTarget(dir, getDefaultSafeCleanupWorld());
			expect(verdict.ok).toBe(true);
			safeRmSync(dir, { recursive: true, force: true });
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			forget();
		}
	});

	test.skipIf(process.platform === "win32")("never permits the home or ancestors even when granted", () => {
		expect(() => registerOwnedDeletionRoot(os.homedir())).toThrow("real home");
		expect(() => registerOwnedDeletionRoot(path.dirname(os.homedir()))).toThrow("real home");
		expect(() => registerOwnedDeletionRoot("/")).toThrow();
		expect(() => registerOwnedDeletionRoot("relative/path")).toThrow("relative");
	});

	test.skipIf(process.platform === "win32")("refuses an existing directory (grant-before-create only)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-grant-existing-"));
		try {
			expect(() => registerOwnedDeletionRoot(dir)).toThrow("already exists");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")("sibling and parent paths stay refused while a grant is active", () => {
		const granted = path.join(os.homedir(), `.gjc-grant-scope-${process.pid}-${Date.now()}`);
		const forget = registerOwnedDeletionRoot(granted);
		try {
			expect(refusalFor(path.dirname(granted), getDefaultSafeCleanupWorld())).toBe("real-home");
			const sibling = path.join(path.dirname(granted), ".gjc-sibling-never-granted");
			expect(refusalFor(sibling, getDefaultSafeCleanupWorld())).toBe("outside-allowed-roots");
		} finally {
			forget();
		}
	});

	test.skipIf(process.platform === "win32")("the grant is forgotten after disposal", () => {
		const granted = path.join(os.homedir(), `.gjc-grant-dispose-${process.pid}-${Date.now()}`);
		const forget = registerOwnedDeletionRoot(granted);
		forget();
		expect(refusalFor(granted, getDefaultSafeCleanupWorld())).toBe("outside-allowed-roots");
	});
});

function isWritable(dir: string): boolean {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Physical case-only sibling tests require a case-sensitive fixture parent.
 * Default APFS is commonly case-insensitive, so probe the same parent rather
 * than assuming a platform-wide Darwin property.
 */
function supportsDistinctCaseOnlySiblings(parent: string): boolean {
	let probe: string | undefined;
	try {
		probe = fs.mkdtempSync(path.join(parent, "gjc-case-probe-"));
		const lower = path.join(probe, "case");
		fs.mkdirSync(lower);
		return !fs.existsSync(path.join(probe, "CASE"));
	} catch {
		return false;
	} finally {
		if (probe !== undefined) fs.rmSync(probe, { recursive: true, force: true });
	}
}
