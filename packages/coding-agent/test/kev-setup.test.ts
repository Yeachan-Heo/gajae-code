import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type KevProcessIdentity, type KevSetupDeps, runKevSetup } from "../src/setup/kev-setup";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kev-test-"));
	roots.push(base);
	const root = path.join(base, "installation");
	const stateDir = path.join(base, "agent-state");
	const snapshot = path.join(base, "snapshot");
	await fs.mkdir(snapshot);
	await Bun.write(path.join(snapshot, "head.pt"), "unit-test fixture, not a trained model");
	const calls: Array<{ argv: string[]; cwd: string }> = [];
	const processes = new Map<number, KevProcessIdentity>();
	const signals: Array<{ pid: number; signal: string }> = [];
	const spawned: string[][] = [];
	const killedHandles: number[] = [];
	const deps: KevSetupDeps = {
		stateDir,
		run: async (argv, options) => {
			expect((await fs.stat(options.cwd)).isDirectory()).toBe(true);
			calls.push({ argv: [...argv], cwd: options.cwd });
			if (argv[0] === "git" && argv[1] === "clone") await fs.mkdir(path.join(root, "repo"), { recursive: true });
			if (argv[0] === "uv" && argv[1] === "sync")
				await fs.mkdir(path.join(root, "repo", ".venv"), { recursive: true });
			let stdout = "";
			if (argv[1] === "remote") stdout = "https://github.com/jaredpalmer/kev.git";
			if (argv[1] === "rev-parse") stdout = REVISION;
			if (argv[2]?.includes("snapshot_download")) stdout = snapshot;
			return { exitCode: 0, stdout, stderr: "" };
		},
		spawn: argv => {
			const pid = 42 + spawned.length;
			spawned.push([...argv]);
			processes.set(pid, { command: argv.join(" "), incarnation: "Fri Oct 2 12:34:56 2026" });
			return {
				pid,
				unref() {},
				kill() {
					killedHandles.push(pid);
					processes.delete(pid);
				},
			};
		},
		inspect: pid => processes.get(pid),
		kill: (pid, signal) => {
			signals.push({ pid, signal });
			processes.delete(pid);
		},
		portAvailable: () => true,
		listens: () => true,
		health: async () => true,
		sleep: async () => {},
		readyTimeoutMs: 1,
	};
	return { root, base, stateDir, snapshot, calls, processes, signals, spawned, killedHandles, deps };
}

async function privateJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, JSON.stringify(value));
	await fs.chmod(file, 0o600);
}

describe("Kev lifecycle", () => {
	test("installs from existing working directories, verifies revision, and remembers a custom root/model", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root, model: "example/kev-fixture" }, f.deps);
		const clone = f.calls.findIndex(call => call.argv[0] === "git" && call.argv[1] === "clone");
		const sync = f.calls.findIndex(call => call.argv[0] === "uv" && call.argv[1] === "sync");
		const download = f.calls.findIndex(call => call.argv[2]?.includes("snapshot_download"));
		expect(clone).toBeGreaterThan(-1);
		expect(sync).toBeGreaterThan(clone);
		expect(download).toBeGreaterThan(sync);
		expect(f.calls[download]?.argv.at(-1)).toBe("example/kev-fixture");
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({
			state: "stopped",
			root: f.root,
			model: "example/kev-fixture",
		});
		expect((await fs.stat(path.join(f.root, "install.json"))).mode & 0o777).toBe(0o600);
	});

	test("starts a pinned local checkpoint and stops only its recorded process", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		expect(await runKevSetup("start", {}, f.deps)).toMatchObject({ state: "running", pid: 42 });
		expect(f.spawned[0]).toContain(f.snapshot);
		expect(f.spawned[0]).toContain("--fallback");
		expect(f.spawned[0]?.some(arg => arg.startsWith("gjc_kev_owner="))).toBe(true);
		await runKevSetup("start", {}, f.deps);
		expect(f.spawned).toHaveLength(1);
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopped" });
		await runKevSetup("stop", {}, f.deps);
		expect(f.signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(false);
	});

	test("forged empty argv cannot authorize a signal", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await privateJson(path.join(f.root, "server.json"), { version: 1, pid: 42, argv: [] });
		f.processes.set(42, { command: "unrelated-user-work", incarnation: "now" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(f.signals).toEqual([]);
	});

	test("PID reuse with identical command text but a different incarnation fails closed", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.processes.set(42, { command: f.spawned[0]!.join(" "), incarnation: "a-new-process" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(f.signals).toEqual([]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
	});

	test("occupied ports reject startup without spawning or signaling", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		f.deps.portAvailable = () => false;
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow("occupied");
		expect(f.spawned).toEqual([]);
		expect(f.signals).toEqual([]);
	});

	test("does not truncate a symlinked foreign log", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const foreign = path.join(f.base, "foreign.txt");
		await Bun.write(foreign, "preserve me");
		await fs.symlink(foreign, path.join(f.root, "server.log"));
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow();
		expect(await Bun.file(foreign).text()).toBe("preserve me");
		expect(f.spawned).toEqual([]);
	});

	test("refuses revision drift before starting a process", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const run = f.deps.run!;
		f.deps.run = (argv, options) =>
			argv[1] === "rev-parse"
				? Promise.resolve({ exitCode: 0, stdout: "f".repeat(40), stderr: "" })
				: run(argv, options);
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow("revision mismatch");
		expect(f.spawned).toEqual([]);
	});

	test("reports loading honestly and can stop an owned not-yet-ready process", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		f.deps.listens = () => false;
		expect(await runKevSetup("start", {}, f.deps)).toMatchObject({ state: "starting" });
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ state: "starting" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopped" });
	});

	test("retains ownership when a signaled process remains alive", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.deps.kill = (pid, signal) => {
			f.signals.push({ pid, signal });
		};
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopping" });
		expect(f.signals).toHaveLength(1);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
	});
});
