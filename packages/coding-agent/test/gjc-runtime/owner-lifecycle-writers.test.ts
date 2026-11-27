import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureOwnerGenerationBaselineSync,
	createOwnerIntent,
	lifecyclePaths,
	observeOwnerTerminal,
	planTmuxOwnerIsolation,
	recordManagedOwnerChildExit,
	replaceOwnerGeneration,
	replaceOwnerGenerationSync,
} from "../../src/gjc-runtime/tmux-owner-isolation";

/**
 * Lifecycle writers that used to create their root and files by pathname: none of
 * them may create, open, chmod, rename or unlink anything through a link in the
 * lifecycle path. Windows links follow the native policy and are not covered here.
 */
const describePosix = describe.skipIf(process.platform === "win32");

const bases: string[] = [];
afterEach(() => {
	for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
});

function fixture(): string {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-owner-writers-")));
	bases.push(base);
	return base;
}

/** Every entry below `dir` with its type, mode and content digest. */
function treeSnapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string) => {
		for (const name of fs.readdirSync(current).sort()) {
			const full = path.join(current, name);
			const stat = fs.lstatSync(full);
			const rel = path.relative(dir, full);
			if (stat.isDirectory()) {
				out[rel] = `dir ${(stat.mode & 0o7777).toString(8)}`;
				walk(full);
			} else if (stat.isFile()) {
				const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
				out[rel] = `file ${(stat.mode & 0o7777).toString(8)} ${stat.nlink} ${digest}`;
			} else out[rel] = `other ${(stat.mode & 0o7777).toString(8)}`;
		}
	};
	walk(dir);
	return out;
}

const terminal = (state: string, generation: string) => ({
	schema_version: 1 as const,
	op: "observe_terminal" as const,
	session_id: "session",
	owner_generation: generation,
	state_dir: state,
	socket_key: "socket",
	observer: "sidecar" as const,
	observed_at: new Date().toISOString(),
	signal: "EXIT" as const,
	exit_code: 0,
	exit_kind: "exit",
	reason: "test",
});

const intentInput = (generation: string) => ({
	generation,
	session_id: "session",
	server_key: "socket",
	expected_terminal: { signal: "SIGTERM" as const, result: "owner_term_then_session_cleanup" as const },
	dispatch_id: "dispatch",
	created_at: new Date(Date.now() - 1_000).toISOString(),
	expires_at: new Date(Date.now() + 60_000).toISOString(),
});

/**
 * A real lifecycle (published generation) placed outside the path the writer is
 * given; the writer reaches it only through a link at `layout`.
 */
async function linkedLifecycle(layout: "state" | "session" | "root"): Promise<{
	state: string;
	outside: string;
	generation: string;
}> {
	const base = fixture();
	const outside = path.join(base, "outside");
	const generation = await replaceOwnerGeneration(outside, "session", "generation");
	const state = path.join(base, "state");
	if (layout === "state") fs.symlinkSync(outside, state);
	else if (layout === "session") {
		fs.mkdirSync(state);
		fs.symlinkSync(path.join(outside, "session"), path.join(state, "session"));
	} else {
		fs.mkdirSync(path.join(state, "session"), { recursive: true });
		fs.symlinkSync(path.join(outside, "session", "owner-lifecycle"), path.join(state, "session", "owner-lifecycle"));
	}
	return { state, outside, generation };
}

const LAYOUTS = [
	["the state directory", "state"],
	["the session directory", "session"],
	["the lifecycle root", "root"],
] as const;

describePosix("owner lifecycle writers refuse a linked lifecycle path", () => {
	it.each(LAYOUTS)("generation publication when %s is a link", async (_name, layout) => {
		const { state, outside } = await linkedLifecycle(layout);
		const before = treeSnapshot(outside);
		await expect(replaceOwnerGeneration(state, "session", "next")).rejects.toThrow("generation_lock_contended");
		expect(() =>
			replaceOwnerGenerationSync(
				state,
				"session",
				"next-sync",
				captureOwnerGenerationBaselineSync(state, "session"),
			),
		).toThrow("generation_lock_contended");
		expect(treeSnapshot(outside)).toEqual(before);
	});

	it.each(LAYOUTS)("intent creation when %s is a link", async (_name, layout) => {
		const { state, outside, generation } = await linkedLifecycle(layout);
		const before = treeSnapshot(outside);
		await expect(createOwnerIntent(state, intentInput(generation))).rejects.toThrow("owner_lifecycle_root_unsafe");
		expect(treeSnapshot(outside)).toEqual(before);
	});

	it.each(LAYOUTS)("terminal observation when %s is a link", async (_name, layout) => {
		const { state, outside, generation } = await linkedLifecycle(layout);
		const before = treeSnapshot(outside);
		await expect(observeOwnerTerminal(terminal(state, generation))).rejects.toThrow("verdict_lock_contended");
		expect(treeSnapshot(outside)).toEqual(before);
	});

	it.each(LAYOUTS)("an unexplained child exit when %s is a link", async (_name, layout) => {
		const { state, outside, generation } = await linkedLifecycle(layout);
		// An unexpected verdict, whose incident is then lost: the exit would publish it again.
		await observeOwnerTerminal(terminal(outside, generation));
		const paths = lifecyclePaths(outside, "session", generation);
		fs.rmSync(paths.incidentFile);
		const before = treeSnapshot(outside);
		await expect(
			recordManagedOwnerChildExit(state, {
				schema_version: 1,
				generation,
				session_id: "session",
				child_token: "token",
				child_pid: 4242,
				intent_id: "intent",
				dispatch_id: "dispatch",
				signal: "SIGABRT",
				exit_code: null,
				explained: false,
				observed_at: new Date().toISOString(),
			}),
		).rejects.toThrow("managed_owner_child_exit_unrecorded");
		expect(treeSnapshot(outside)).toEqual(before);
	});

	const scopedPlan = (state: string) =>
		planTmuxOwnerIsolation(
			{
				schema_version: 1,
				op: "plan",
				platform: "linux",
				session_id: "session",
				owner_generation: "attempt-generation",
				cwd: "/work",
				state_dir: state,
				socket_key: "socket",
				tmux_argv: ["tmux", "new-session", "-d", "-s", "owned-session"],
				// The current baseline, read through the link, so planning reaches the attempt record.
				baseline: captureOwnerGenerationBaselineSync(state, "session"),
			},
			{ readCallerCgroup: async () => "0::/unit.service", probeServer: async () => ({ state: "absent" }) },
		);

	it("records a scoped launch attempt in a plain lifecycle root", async () => {
		const state = path.join(fixture(), "state");
		await replaceOwnerGeneration(state, "session", "generation");
		expect(await scopedPlan(state)).toMatchObject({ ok: true });
		const root = lifecyclePaths(state, "session", "generation").root;
		expect(fs.readdirSync(root).some(name => name.startsWith("attempt-"))).toBe(true);
	});

	it.each(LAYOUTS)("a scoped launch attempt when %s is a link", async (_name, layout) => {
		const { state, outside } = await linkedLifecycle(layout);
		const before = treeSnapshot(outside);
		expect(await scopedPlan(state)).toMatchObject({ ok: false, code: "scope_unavailable" });
		expect(treeSnapshot(outside)).toEqual(before);
	});

	it("refuses a dangling link and a file in place of the lifecycle root without creating anything", async () => {
		const base = fixture();
		const outside = path.join(base, "outside");
		fs.mkdirSync(outside);
		const dangling = path.join(base, "dangling");
		fs.mkdirSync(path.join(dangling, "session"), { recursive: true });
		fs.symlinkSync(path.join(outside, "missing"), path.join(dangling, "session", "owner-lifecycle"));
		const regular = path.join(base, "regular");
		fs.mkdirSync(path.join(regular, "session"), { recursive: true });
		fs.writeFileSync(path.join(regular, "session", "owner-lifecycle"), "sentinel");
		for (const state of [dangling, regular]) {
			await expect(replaceOwnerGeneration(state, "session", "g")).rejects.toThrow("generation_lock_contended");
			await expect(createOwnerIntent(state, intentInput("g"))).rejects.toThrow("owner_lifecycle_root_unsafe");
		}
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(fs.readFileSync(path.join(regular, "session", "owner-lifecycle"), "utf8")).toBe("sentinel");
	});
});

describePosix("owner lifecycle lock database", () => {
	async function rootWithLockLeaf(make: (lock: string, outside: string) => void) {
		const base = fixture();
		const state = path.join(base, "state");
		const outside = path.join(base, "outside");
		fs.mkdirSync(outside);
		const root = lifecyclePaths(state, "session", "g").root;
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		make(lifecyclePaths(state, "session", "g").lockDatabaseFile, outside);
		return { state, outside, root };
	}

	it.each([
		[
			"a symlink",
			(lock: string, outside: string) => {
				fs.writeFileSync(path.join(outside, "target"), "sentinel", { mode: 0o644 });
				fs.symlinkSync(path.join(outside, "target"), lock);
			},
		],
		[
			"a hardlink",
			(lock: string, outside: string) => {
				fs.writeFileSync(path.join(outside, "target"), "sentinel", { mode: 0o644 });
				fs.linkSync(path.join(outside, "target"), lock);
			},
		],
		["a directory", (lock: string) => fs.mkdirSync(lock)],
	] as const)("is refused without opening or changing its target when it is %s", async (_name, make) => {
		const { state, outside } = await rootWithLockLeaf(make);
		const before = treeSnapshot(outside);
		await expect(replaceOwnerGeneration(state, "session", "g")).rejects.toThrow("generation_lock_contended");
		expect(() => replaceOwnerGenerationSync(state, "session", "g-sync", { state: "absent" })).toThrow(
			"generation_lock_contended",
		);
		expect(treeSnapshot(outside)).toEqual(before);
	});

	it("is refused without blocking when it is a FIFO", async () => {
		const base = fixture();
		const state = path.join(base, "state");
		const lock = lifecyclePaths(state, "session", "g").lockDatabaseFile;
		fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
		expect(Bun.spawnSync(["mkfifo", lock]).exitCode).toBe(0);
		// A blocking open would hang the test runner, so the writer runs in its own process.
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { replaceOwnerGenerationSync } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/gjc-runtime/tmux-owner-isolation.ts"))});
try { replaceOwnerGenerationSync(${JSON.stringify(state)}, "session", "g", { state: "absent" }); } catch (error) { console.log(error.message); }`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		try {
			expect(await child.exited).toBe(0);
			expect((await new Response(child.stdout).text()).trim()).toBe("generation_lock_contended");
		} finally {
			clearTimeout(timer);
		}
		expect(fs.lstatSync(lock).isFIFO()).toBe(true);
	}, 25_000);

	it("creates a missing lock database owner-only and keeps an existing one", async () => {
		const base = fixture();
		const state = path.join(base, "state");
		await replaceOwnerGeneration(state, "session", "first");
		const lock = lifecyclePaths(state, "session", "first").lockDatabaseFile;
		const created = fs.lstatSync(lock);
		expect({ file: created.isFile(), mode: created.mode & 0o777, links: created.nlink }).toEqual({
			file: true,
			mode: 0o600,
			links: 1,
		});
		replaceOwnerGenerationSync(state, "session", "second", captureOwnerGenerationBaselineSync(state, "session"));
		expect(fs.lstatSync(lock).ino).toBe(created.ino);
	});

	it("opens an existing group-readable lock database without changing its mode", async () => {
		// A database another writer created (for example `postmortem.sh`) is used as it is.
		const base = fixture();
		const state = path.join(base, "state");
		const lock = lifecyclePaths(state, "session", "g").lockDatabaseFile;
		fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
		new Database(lock).close();
		fs.chmodSync(lock, 0o644);
		await replaceOwnerGeneration(state, "session", "g");
		expect(fs.lstatSync(lock).mode & 0o777).toBe(0o644);
	});

	it("keeps this process's lock held while a second acquisition opens the same database and gives up", async () => {
		const base = fixture();
		const state = path.join(base, "state");
		const generation = await replaceOwnerGeneration(state, "session", "generation");
		const lock = lifecyclePaths(state, "session", generation).lockDatabaseFile;
		// This process holds the lock through one connection, as a writer awaiting I/O would.
		const held = new Database(lock);
		held.exec("BEGIN IMMEDIATE");
		const contender = () =>
			Bun.spawnSync([
				process.execPath,
				"-e",
				`const { Database } = await import("bun:sqlite");
const db = new Database(${JSON.stringify(lock)});
db.exec("PRAGMA busy_timeout = 0");
try { db.exec("BEGIN IMMEDIATE"); console.log("acquired"); } catch (error) { console.log(error.code ?? error.message); }`,
			])
				.stdout.toString()
				.trim();
		try {
			expect(contender()).toBe("SQLITE_BUSY");
			// A second acquisition in this process opens the same database and gives up.
			await expect(observeOwnerTerminal(terminal(state, generation))).rejects.toThrow("verdict_lock_contended");
			expect(contender()).toBe("SQLITE_BUSY");
		} finally {
			held.exec("ROLLBACK");
			held.close();
		}
		expect(contender()).toBe("acquired");
	}, 20_000);
});

describePosix("owner lifecycle roots that stay accepted", () => {
	it("publishes into an existing group-readable root without changing its mode", async () => {
		// Raw-session scripts create the root with `mkdir -p` and the default umask.
		const base = fixture();
		const state = path.join(base, "state");
		const root = lifecyclePaths(state, "session", "g").root;
		fs.mkdirSync(root, { recursive: true });
		fs.chmodSync(root, 0o755);
		await replaceOwnerGeneration(state, "session", "g");
		expect(fs.statSync(root).mode & 0o777).toBe(0o755);
		expect(fs.existsSync(lifecyclePaths(state, "session", "g").generationFile)).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")("accepts a state directory spelled through the /tmp alias", async () => {
		const state = fs.mkdtempSync("/tmp/gjc-owner-writers-alias-");
		bases.push(state);
		expect(state.startsWith("/tmp/")).toBe(true);
		const generation = await replaceOwnerGeneration(state, "session", "g");
		await createOwnerIntent(state, intentInput(generation));
		expect(fs.existsSync(lifecyclePaths(state, "session", generation).intentFile)).toBe(true);
	});

	it("creates a missing lifecycle root owner-only", async () => {
		const state = path.join(fixture(), "state");
		const generation = await replaceOwnerGeneration(state, "session", "g");
		expect(fs.statSync(lifecyclePaths(state, "session", generation).root).mode & 0o777).toBe(0o700);
	});
});
