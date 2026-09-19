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
	TEMP_DIR_OWNER_MARKER,
} from "./helpers/temp-dir-registry";

const HELPER_MODULE = path.join(import.meta.dir, "helpers", "temp-dir-registry.ts");
const PREFIX = "pi-temp-dir-registry-test-";
/** Comfortably past the age gate, so age is never what keeps a root alive. */
const ANCIENT_MS = STALE_TEMP_DIR_REAP_AGE_MS + 60_000;
/** Stand-in owner pid for cases that inject their own probe verdict. */
const DEAD_PID = 999_999;

/** Scratch roots this file owns, removed unconditionally after every case. */
const scratchRoots: string[] = [];

function makeScratchRoot(): string {
	const root = path.join(os.tmpdir(), `${PREFIX}${Snowflake.next()}`);
	fs.mkdirSync(root, { recursive: true });
	scratchRoots.push(root);
	return root;
}

function writeMarker(dir: string, owner: { pid: number; host: string; startedAt: number }): void {
	fs.writeFileSync(path.join(dir, TEMP_DIR_OWNER_MARKER), JSON.stringify(owner));
}

function ageDir(dir: string, ageMs: number): void {
	const stamp = new Date(Date.now() - ageMs);
	fs.utimesSync(dir, stamp, stamp);
}

/** A prefixed root with a well-formed marker, aged by both mtime and `startedAt`. */
function makeOwnedRoot(root: string, name: string, options: { ageMs: number; pid?: number; host?: string }): string {
	const dir = path.join(root, `${PREFIX}${name}`);
	fs.mkdirSync(dir);
	writeMarker(dir, {
		pid: options.pid ?? DEAD_PID,
		host: options.host ?? os.hostname(),
		startedAt: Date.now() - options.ageMs,
	});
	ageDir(dir, options.ageMs);
	return dir;
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

	it("register writes an ownership marker naming this process", () => {
		const root = makeScratchRoot();
		const dir = path.join(root, "claimed");
		fs.mkdirSync(dir);

		createTempDirRegistry().register(dir);

		const marker = JSON.parse(fs.readFileSync(path.join(dir, TEMP_DIR_OWNER_MARKER), "utf8")) as {
			pid: number;
			host: string;
			startedAt: number;
		};
		expect(marker.pid).toBe(process.pid);
		expect(marker.host).toBe(os.hostname());
		expect(Number.isFinite(marker.startedAt)).toBe(true);
	});

	it("reaps a dead-owner root and leaves a fresh one", () => {
		const root = makeScratchRoot();
		const stale = makeOwnedRoot(root, "stale", { ageMs: ANCIENT_MS });
		const fresh = makeOwnedRoot(root, "fresh", { ageMs: 0 });
		const unrelated = path.join(root, "pi-some-other-suite-stale");
		fs.mkdirSync(unrelated);
		writeMarker(unrelated, { pid: DEAD_PID, host: os.hostname(), startedAt: Date.now() - ANCIENT_MS });

		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "dead" });

		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		// Prefix scoping: an equally stale dir from another suite is not ours.
		expect(fs.existsSync(unrelated)).toBe(true);
	});

	// The reviewer's scenario for #5672: a shard paused at a breakpoint, or one
	// simply running long, leaves its root untouched past the age gate while
	// still holding it. Age alone would delete a live run's session state.
	it("keeps an ancient root whose owner is still alive", () => {
		const root = makeScratchRoot();
		const live = makeOwnedRoot(root, "live", { ageMs: ANCIENT_MS });

		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "alive" });

		expect(fs.existsSync(live)).toBe(true);
	});

	it("keeps an ancient root when the probe cannot answer", () => {
		const root = makeScratchRoot();
		const opaque = makeOwnedRoot(root, "opaque", { ageMs: ANCIENT_MS });

		// EPERM and any other refusal land here: not evidence of death.
		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "unknown" });

		expect(fs.existsSync(opaque)).toBe(true);
	});

	it("keeps an ancient root that carries no marker at all", () => {
		const root = makeScratchRoot();
		const unmarked = path.join(root, `${PREFIX}unmarked`);
		fs.mkdirSync(unmarked);
		ageDir(unmarked, ANCIENT_MS);

		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "dead" });

		// Roots predating the marker cannot be proven abandoned, so they stay.
		expect(fs.existsSync(unmarked)).toBe(true);
	});

	it("keeps an ancient root whose marker is unparseable", () => {
		const root = makeScratchRoot();
		const garbled = path.join(root, `${PREFIX}garbled`);
		fs.mkdirSync(garbled);
		fs.writeFileSync(path.join(garbled, TEMP_DIR_OWNER_MARKER), "{not json");
		ageDir(garbled, ANCIENT_MS);

		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "dead" });

		expect(fs.existsSync(garbled)).toBe(true);
	});

	it("keeps an ancient root owned by another host", () => {
		const root = makeScratchRoot();
		const foreign = makeOwnedRoot(root, "foreign", { ageMs: ANCIENT_MS, host: `${os.hostname()}-elsewhere` });

		// A pid number only means something on the host that issued it, so a
		// local ESRCH says nothing about a foreign owner.
		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "dead" });

		expect(fs.existsSync(foreign)).toBe(true);
	});

	it("keeps the running process's own root", () => {
		const root = makeScratchRoot();
		const mine = makeOwnedRoot(root, "mine", { ageMs: ANCIENT_MS, pid: process.pid });

		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "dead" });

		expect(fs.existsSync(mine)).toBe(true);
	});

	it("keeps a dead-owner root that is still inside the age window", () => {
		const root = makeScratchRoot();
		const recent = makeOwnedRoot(root, "recent", { ageMs: 60_000 });

		reapStaleTempDirs(PREFIX, { root, now: Date.now(), pidProbe: () => "dead" });

		expect(fs.existsSync(recent)).toBe(true);
	});

	// Exercises the real `process.kill(pid, 0)` path rather than the seam, so
	// the injected probe is not the only thing ever tested.
	it("reaps via the default probe when the owner pid has genuinely exited", () => {
		const exited = Bun.spawnSync({ cmd: ["true"] });
		const exitedPid = exited.pid;
		expect(typeof exitedPid).toBe("number");

		const root = makeScratchRoot();
		const abandoned = makeOwnedRoot(root, "abandoned", { ageMs: ANCIENT_MS, pid: exitedPid });
		const live = makeOwnedRoot(root, "live", { ageMs: ANCIENT_MS, pid: process.pid });

		// No pidProbe: the default probeTempDirOwner runs.
		reapStaleTempDirs(PREFIX, { root, now: Date.now() });

		expect(fs.existsSync(abandoned)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
	});

	it("refuses an empty prefix instead of reaping the whole root", () => {
		const root = makeScratchRoot();
		const victim = path.join(root, "anything");
		fs.mkdirSync(victim);
		writeMarker(victim, { pid: DEAD_PID, host: os.hostname(), startedAt: Date.now() - ANCIENT_MS });
		ageDir(victim, ANCIENT_MS);

		reapStaleTempDirs("", { root, pidProbe: () => "dead" });

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
