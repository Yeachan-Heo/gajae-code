import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";
import {
	createTempDirRegistry,
	reapStaleTempDirs,
	STALE_TEMP_DIR_REAP_AGE_MS,
	sweepAfterSettle,
} from "./helpers/temp-dir-registry";

const HELPER_MODULE = path.join(import.meta.dir, "helpers", "temp-dir-registry.ts");
const PREFIX = "pi-temp-dir-registry-test-";

/** Scratch roots this file owns, removed unconditionally after every case. */
const scratchRoots: string[] = [];

function makeScratchRoot(): string {
	const root = path.join(os.tmpdir(), `${PREFIX}${Snowflake.next()}`);
	fs.mkdirSync(root, { recursive: true });
	scratchRoots.push(root);
	return root;
}

afterEach(() => {
	while (scratchRoots.length) {
		const root = scratchRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("temp dir registry", () => {
	it("sweeps a dir that was registered but never released", () => {
		const root = makeScratchRoot();
		const leaked = path.join(root, "leaked");
		fs.mkdirSync(leaked);
		const registry = createTempDirRegistry();
		registry.register(leaked);

		expect(registry.owned()).toEqual([leaked]);
		registry.sweep();

		expect(fs.existsSync(leaked)).toBe(false);
		expect(registry.owned()).toEqual([]);
	});

	it("releases eagerly and leaves the sweep a no-op", () => {
		const root = makeScratchRoot();
		const reclaimed = path.join(root, "reclaimed");
		fs.mkdirSync(reclaimed);
		const registry = createTempDirRegistry();
		registry.register(reclaimed);

		registry.release(reclaimed);
		expect(fs.existsSync(reclaimed)).toBe(false);
		expect(registry.owned()).toEqual([]);

		// The sweep must tolerate an already-reclaimed dir rather than throw.
		expect(() => registry.sweep()).not.toThrow();
		expect(fs.existsSync(reclaimed)).toBe(false);
	});

	// The second leak path measured on #5665: teardown removed the dir, then a
	// writer that outlived teardown recreated it. Release alone cannot cover
	// this, so the sweep must revisit released dirs too.
	it("sweeps a released dir that was recreated after teardown", () => {
		const root = makeScratchRoot();
		const recreated = path.join(root, "recreated");
		fs.mkdirSync(recreated);
		const registry = createTempDirRegistry();
		registry.register(recreated);

		registry.release(recreated);
		expect(fs.existsSync(recreated)).toBe(false);

		// A lazy writer wakes up after teardown and rebuilds the tree.
		fs.mkdirSync(path.join(recreated, "model-presets"), { recursive: true });
		fs.writeFileSync(path.join(recreated, "models.db"), "");
		expect(registry.owned()).toEqual([]);
		expect(registry.tracked()).toEqual([recreated]);

		registry.sweep();

		expect(fs.existsSync(recreated)).toBe(false);
	});

	// A single sweep left one empty root per suite run, recreated after
	// `afterAll` had already swept. The follow-up sweep is what closes it.
	it("sweeps again after the settle window for a root recreated post-sweep", async () => {
		const root = makeScratchRoot();
		const late = path.join(root, "late");
		fs.mkdirSync(late);
		const registry = createTempDirRegistry();
		registry.register(late);

		// A writer still in flight when the first sweep runs.
		setTimeout(() => fs.mkdirSync(late, { recursive: true }), 20);

		await sweepAfterSettle(registry, 120);

		expect(fs.existsSync(late)).toBe(false);
	});

	it("reaps a stale root and leaves a fresh one", () => {
		const root = makeScratchRoot();
		const stale = path.join(root, `${PREFIX}stale`);
		const fresh = path.join(root, `${PREFIX}fresh`);
		const unrelated = path.join(root, "pi-some-other-suite-stale");
		for (const dir of [stale, fresh, unrelated]) fs.mkdirSync(dir);

		const now = Date.now();
		const old = new Date(now - STALE_TEMP_DIR_REAP_AGE_MS - 60_000);
		fs.utimesSync(stale, old, old);
		fs.utimesSync(unrelated, old, old);

		reapStaleTempDirs(PREFIX, { root, now });

		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		// Prefix scoping: an equally stale dir from another suite is not ours.
		expect(fs.existsSync(unrelated)).toBe(true);
	});

	it("refuses an empty prefix instead of reaping the whole root", () => {
		const root = makeScratchRoot();
		const victim = path.join(root, "anything");
		fs.mkdirSync(victim);
		const old = new Date(Date.now() - STALE_TEMP_DIR_REAP_AGE_MS - 60_000);
		fs.utimesSync(victim, old, old);

		reapStaleTempDirs("", { root });

		expect(fs.existsSync(victim)).toBe(true);
	});

	// The path that actually leaks (issue #5665): Bun abandons an `afterEach`
	// that exceeds its budget, so the hook's own `finally` never runs. Driven in
	// a child `bun test` because a hook timeout marks its case failed — inlining
	// it here would leave this file permanently red.
	it("reclaims a dir whose afterEach hook timed out before its finally ran", async () => {
		const root = makeScratchRoot();
		const leakDir = path.join(root, "leaked-by-hook-timeout");
		const reportPath = path.join(root, "report.json");
		const fixturePath = path.join(root, "hook-timeout.test.ts");

		fs.writeFileSync(
			fixturePath,
			`import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import { createTempDirRegistry } from ${JSON.stringify(HELPER_MODULE)};

const registry = createTempDirRegistry();
const leakDir = process.env.LEAK_DIR;
const reportPath = process.env.SWEEP_REPORT;

beforeEach(() => {
	fs.mkdirSync(leakDir, { recursive: true });
	registry.register(leakDir);
});

// Budget is deliberately shorter than the hook body, so Bun abandons the hook
// mid-await and the \`finally\` below never runs.
afterEach(async () => {
	try {
		await Bun.sleep(3_000);
	} finally {
		registry.release(leakDir);
	}
}, 300);

afterAll(() => {
	const leakedBeforeSweep = fs.existsSync(leakDir);
	registry.sweep();
	fs.writeFileSync(reportPath, JSON.stringify({ leakedBeforeSweep, existsAfterSweep: fs.existsSync(leakDir) }));
});

it("body passes, then its afterEach exceeds the budget", () => {
	expect(fs.existsSync(leakDir)).toBe(true);
});
`,
		);

		const child = Bun.spawnSync({
			cmd: [process.execPath, "test", "./hook-timeout.test.ts"],
			cwd: root,
			env: { ...process.env, LEAK_DIR: leakDir, SWEEP_REPORT: reportPath },
			stdout: "pipe",
			stderr: "pipe",
		});

		// The hook timeout fails the child's case; that failure is the condition
		// under test, not a defect.
		expect(child.exitCode).not.toBe(0);
		expect(fs.existsSync(reportPath)).toBe(true);

		const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
			leakedBeforeSweep: boolean;
			existsAfterSweep: boolean;
		};
		// The dir survived the abandoned hook: the leak is real, not hypothetical.
		expect(report.leakedBeforeSweep).toBe(true);
		// ...and `afterAll` still ran and reclaimed it.
		expect(report.existsAfterSweep).toBe(false);
		expect(fs.existsSync(leakDir)).toBe(false);
	}, 30_000);
});
