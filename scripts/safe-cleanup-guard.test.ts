// Verifies the runtime recursive-deletion guard: which surfaces Bun 1.4.0
// actually lets us intercept, that refusals never fall through to the real
// deletion, and that the real preload wiring aborts a violating `bun test`
// child without deleting anything. The Bun interception matrix is pinned here
// on purpose: if a future Bun makes more surfaces interceptable (or breaks
// one), these tests fail and the guard must be updated.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
	__uninstallRuntimeDeletionGuardForTests,
	installRuntimeDeletionGuard,
	getDefaultSafeCleanupWorld,
	type DeletionRefusal,
	type DeletionRefusalReason,
	type SafeCleanupWorld,
} from "./safe-cleanup";

const require = createRequire(import.meta.url);

function sandboxWorld(sandboxRoot: string): SafeCleanupWorld {
	return {
		pathModule: path,
		homeAliases: ["/home/guard-probe-op"],
		allowedRoots: [sandboxRoot],
		realpathSync: (target: string) => fs.realpathSync(target),
		existsSync: (target: string) => fs.existsSync(target),
		statUid: (target: string) => fs.statSync(target).uid,
		uid: process.getuid?.(),
		caseInsensitive: false,
	};
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const recorded: Array<{ reason: DeletionRefusalReason; target: string }> = [];
let sandbox = "";

afterEach(() => {
	__uninstallRuntimeDeletionGuardForTests();
	// Restore the production posture the preload installed, so later test
	// files in this process keep the default-world guard.
	installRuntimeDeletionGuard({ label: "test-preload" });
	recorded.length = 0;
	if (sandbox && fs.existsSync(sandbox)) {
		fs.rmSync(sandbox, { recursive: true, force: true });
		sandbox = "";
	}
});

function install(world: SafeCleanupWorld): void {
	// The preload already installed the default-world guard in this process;
	// swap it for the scenario world under test.
	__uninstallRuntimeDeletionGuardForTests();
	installRuntimeDeletionGuard({
		world,
		label: "guard-test",
		onViolation: (refusal: DeletionRefusal, target: string) => {
			recorded.push({ reason: refusal.reason, target });
		},
	});
}

describe("runtime deletion guard: interceptable surfaces", () => {
	test("fs.promises.rm refusal blocks the deletion and records the reason", async () => {
		sandbox = tempDir("gjc-guard-sbx-");
		const outside = tempDir("gjc-guard-outside-"); // inside os.tmpdir(), outside the guard's allowed root
		fs.mkdirSync(path.join(outside, "child"), { recursive: true });
		install(sandboxWorld(sandbox));
		await expect(fs.promises.rm(outside, { recursive: true, force: true })).rejects.toThrow(
			"refusing to delete",
		);
		expect(recorded.map((entry) => entry.reason)).toEqual(["outside-allowed-roots"]);
		// Fail-closed proof: the refused tree is untouched.
		expect(fs.existsSync(path.join(outside, "child"))).toBe(true);
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("fs.promises.rm approves and completes inside the allowed root", async () => {
		sandbox = tempDir("gjc-guard-sbx-");
		const victim = path.join(sandbox, "victim");
		fs.mkdirSync(victim, { recursive: true });
		install(sandboxWorld(sandbox));
		await fs.promises.rm(victim, { recursive: true, force: true });
		expect(fs.existsSync(victim)).toBe(false);
		expect(recorded).toEqual([]);
	});

	test("CJS require('node:fs').rmSync refusal blocks the deletion", () => {
		sandbox = tempDir("gjc-guard-sbx-");
		const outside = tempDir("gjc-guard-outside-");
		fs.mkdirSync(path.join(outside, "child"), { recursive: true });
		install(sandboxWorld(sandbox));
		expect(() => require("node:fs").rmSync(outside, { recursive: true, force: true })).toThrow(
			"refusing to delete",
		);
		expect(recorded.map((entry) => entry.reason)).toEqual(["outside-allowed-roots"]);
		expect(fs.existsSync(path.join(outside, "child"))).toBe(true);
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("CJS require('node:fs/promises').rm refusal blocks the deletion", async () => {
		sandbox = tempDir("gjc-guard-sbx-");
		const outside = tempDir("gjc-guard-outside-");
		fs.mkdirSync(path.join(outside, "child"), { recursive: true });
		install(sandboxWorld(sandbox));
		await expect(require("node:fs/promises").rm(outside, { recursive: true, force: true })).rejects.toThrow(
			"refusing to delete",
		);
		expect(recorded.map((entry) => entry.reason)).toEqual(["outside-allowed-roots"]);
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("non-recursive removals pass through unassessed", async () => {
		sandbox = tempDir("gjc-guard-sbx-");
		const outside = tempDir("gjc-guard-outside-");
		const file = path.join(outside, "single.txt");
		fs.writeFileSync(file, "x");
		install(sandboxWorld(sandbox));
		await fs.promises.rm(file, { force: true });
		expect(fs.existsSync(file)).toBe(false);
		expect(recorded).toEqual([]);
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("a second install in the same process is a no-op (preload idempotence)", () => {
		sandbox = tempDir("gjc-guard-sbx-");
		const world = sandboxWorld(sandbox);
		// Install directly (the helper swaps by design) to observe idempotence.
		__uninstallRuntimeDeletionGuardForTests();
		installRuntimeDeletionGuard({ world, label: "guard-test" });
		const first = require("node:fs").rmSync;
		installRuntimeDeletionGuard({ world, label: "guard-test-again" });
		expect(require("node:fs").rmSync).toBe(first);
	});

	test.skip("KNOWN GAP (Bun 1.4.0): ESM top-level fs.rmSync is a snapshot binding and is NOT intercepted — the static guard (check-unsafe-rmrf) covers repository source for this surface", () => {
		// Intentionally skipped: this documents the boundary. If Bun ever makes
		// namespace bindings live, move this to a real assertion and extend the
		// guard to patch them.
	});

	test("uninstall removes the guard wrapping and is idempotent", () => {
		sandbox = tempDir("gjc-guard-sbx-");
		install(sandboxWorld(sandbox));
		const wrapped = require("node:fs").rmSync;
		expect(String(wrapped)).toContain("refusalFor");
		__uninstallRuntimeDeletionGuardForTests();
		const restored = require("node:fs").rmSync;
		expect(String(restored)).not.toContain("refusalFor");
		__uninstallRuntimeDeletionGuardForTests();
		expect(require("node:fs").rmSync).toBe(restored);
	});
});

describe("runtime deletion guard: real preload wiring (subprocess)", () => {
	const repoRoot = path.join(import.meta.dir, "..");
	const fixturesDir = path.join(repoRoot, "scripts", "test-fixtures");

	function runFixture(name: string, env: Record<string, string>): { exitCode: number; stderr: string } {
		const proc = Bun.spawnSync({
			cmd: [process.execPath, "test", path.join(fixturesDir, name)],
			cwd: repoRoot,
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: proc.exitCode,
			stderr: new TextDecoder().decode(proc.stderr),
		};
	}

	/** Removal outside any guarded surface: a plain `bun -e` process has no preload. */
	function unguardedRm(target: string): void {
		const proc = Bun.spawnSync({
			cmd: [process.execPath, "-e", "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })", target],
			cwd: repoRoot,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) throw new Error(`unguarded cleanup failed for ${target}`);
	}

	test.skipIf(process.platform !== "linux" || !isWritable("/dev/shm"))(
		"bun test child aborts (exit 70) on an out-of-root recursive rm and deletes nothing",
		() => {
			const probe = fs.mkdtempSync("/dev/shm/gjc-guard-e2e-");
			fs.mkdirSync(path.join(probe, "precious"), { recursive: true });
			const result = runFixture("guard-violation-fixture.ts", { GJC_GUARD_PROBE_DIR: probe });
			expect(result.exitCode).toBe(70);
			expect(result.stderr).toContain("[safe-cleanup:test-preload]");
			expect(result.stderr).toContain("REFUSED recursive deletion");
			// The refused tree must still exist.
			expect(fs.existsSync(path.join(probe, "precious"))).toBe(true);
			unguardedRm(probe);
		},
	);

	test("bun test child completes normally for owned in-root cleanup", () => {
		const probe = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-guard-pass-"));
		fs.mkdirSync(path.join(probe, "child"), { recursive: true });
		const result = runFixture("guard-pass-fixture.ts", { GJC_GUARD_PROBE_DIR: probe });
		expect(result.exitCode).toBe(0);
		expect(fs.existsSync(probe)).toBe(false);
	});

	test.skipIf(process.platform === "win32")(
		"the child ignores an ambient fake HOME when resolving the real account home",
		() => {
			const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-guard-fakehome-"));
			fs.mkdirSync(path.join(fakeHome, "identity"), { recursive: true });
			// The fake home sits INSIDE the allowed tmp root, so only the
			// captured home alias — not containment — can refuse it.
			const result = runFixture("guard-env-home-fixture.ts", {
				HOME: fakeHome,
				GJC_GUARD_PROBE_DIR: fakeHome,
			});
			expect(result.exitCode).toBe(0);
			expect(fs.existsSync(fakeHome)).toBe(false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"the child refuses a real-home child when HOME and TMPDIR point at attacker-controlled roots",
		() => {
			const realHome = getDefaultSafeCleanupWorld().homeAliases[0];
			if (!realHome) throw new Error("Expected an independently resolved real home");
			const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-guard-ambient-home-"));
			const target = path.join(realHome, `.gjc-guard-ambient-${process.pid}-${Date.now()}`);
			try {
				const result = runFixture("guard-violation-fixture.ts", {
					HOME: fakeHome,
					TMPDIR: realHome,
					GJC_GUARD_PROBE_DIR: target,
				});
				expect(result.exitCode).toBe(70);
				expect(result.stderr).toContain("outside-allowed-roots");
				expect(fs.existsSync(target)).toBe(false);
			} finally {
				fs.rmSync(fakeHome, { recursive: true, force: true });
			}
		},
	);
});

function isWritable(dir: string): boolean {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
