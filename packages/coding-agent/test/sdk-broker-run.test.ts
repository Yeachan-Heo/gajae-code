import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { brokerDiscoveryPath, brokerProcessIncarnation, readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { ensureBroker, SDK_BROKER_AUTOSTART_ENV } from "../src/sdk/broker/ensure";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function agentDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-run-"));
	roots.push(root);
	const dir = path.join(root, "agent");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

function brokerRun(dir: string, extraEnv: Record<string, string> = {}): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const env = { ...process.env, ...extraEnv };
	delete env[SDK_BROKER_AUTOSTART_ENV];
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "broker", "run", "--agent-dir", dir], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	children.push(child);
	return child;
}

async function waitForOwner(dir: string, child: Bun.Subprocess): Promise<number> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const discovery = await readBrokerDiscovery(dir);
		if (discovery) return discovery.pid;
		if (child.exitCode !== null) throw new Error(`broker run exited early with ${child.exitCode}`);
		if (Date.now() > deadline) throw new Error("broker run did not publish discovery");
		await Bun.sleep(50);
	}
}

it("serves in the foreground, refuses a second owner, and stops gracefully on SIGTERM", async () => {
	const dir = await agentDir();
	const owner = brokerRun(dir);
	// Foreground: the published owner is the supervised process itself, not a detached child.
	expect(await waitForOwner(dir, owner)).toBe(owner.pid);

	// Attach-only clients reach the supervised broker.
	const prior = process.env[SDK_BROKER_AUTOSTART_ENV];
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	try {
		expect((await ensureBroker({ agentDir: dir })).pid).toBe(owner.pid);
	} finally {
		if (prior === undefined) delete process.env[SDK_BROKER_AUTOSTART_ENV];
		else process.env[SDK_BROKER_AUTOSTART_ENV] = prior;
	}

	// A second supervised run must fail visibly instead of reporting success as the race loser.
	const second = brokerRun(dir);
	const [secondExit, secondStderr] = await Promise.all([second.exited, new Response(second.stderr).text()]);
	expect(secondExit).toBe(1);
	expect(secondStderr).toContain("another SDK broker already owns");
	expect((await readBrokerDiscovery(dir))?.pid).toBe(owner.pid);

	owner.kill("SIGTERM");
	// Graceful stop, then the conventional signal status (128 + SIGTERM) for the supervisor.
	expect(await owner.exited).toBe(143);
	expect(await readBrokerDiscovery(dir)).toBeNull();
	expect(await fs.readFile(path.join(dir, "sdk", "broker.json"), "utf8").catch(() => null)).toBeNull();
}, 90_000);

it("stops gracefully on SIGINT with the SIGINT status", async () => {
	const dir = await agentDir();
	const owner = brokerRun(dir);
	expect(await waitForOwner(dir, owner)).toBe(owner.pid);
	owner.kill("SIGINT");
	expect(await owner.exited).toBe(130);
	expect(await readBrokerDiscovery(dir)).toBeNull();
}, 90_000);

it("refuses a live incompatible incumbent without retiring it", async () => {
	const dir = await agentDir();
	// A live process the old autostart reconciliation would SIGTERM as an unusable generation.
	const incumbent = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	children.push(incumbent);
	const file = brokerDiscoveryPath(dir);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(
		file,
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "0.0.0-incompatible",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "t",
			pid: incumbent.pid,
			incarnation: brokerProcessIncarnation(incumbent.pid),
			heartbeatAt: Date.now(),
		}),
	);
	const before = await fs.readFile(file, "utf8");
	expect((await readBrokerDiscovery(dir))?.pid).toBe(incumbent.pid);

	const run = brokerRun(dir);
	const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
	expect(exitCode).toBe(1);
	expect(stderr).toContain("another SDK broker already owns");
	expect(await fs.readFile(file, "utf8")).toBe(before);
	expect(incumbent.exitCode).toBeNull();
}, 90_000);

it("exits 1 when startup fails, without publishing an owner", async () => {
	const dir = await agentDir();
	const run = brokerRun(dir, {
		GJC_SDK_TEST_BROKER_STARTUP_STALL: "1",
		GJC_SDK_TEST_BROKER_STARTUP_WATCHDOG_MS: "2000",
	});
	expect(await run.exited).toBe(1);
	expect(await readBrokerDiscovery(dir)).toBeNull();
}, 90_000);

it("exits 1 when it loses its discovery root, leaving the successor's record intact", async () => {
	const dir = await agentDir();
	const owner = brokerRun(dir);
	expect(await waitForOwner(dir, owner)).toBe(owner.pid);
	const file = brokerDiscoveryPath(dir);
	// Another owner atomically publishes over this broker's record (a new file identity).
	const successor = JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), ownerId: "successor-owner" });
	await Bun.write(`${file}.successor`, successor);
	await fs.rename(`${file}.successor`, file);
	const [exitCode, stderr] = await Promise.all([owner.exited, new Response(owner.stderr).text()]);
	expect(exitCode).toBe(1);
	expect(stderr).toContain("stopped abnormally (lost-root");
	expect(await fs.readFile(file, "utf8")).toBe(successor);
}, 120_000);

it("exits 1 through the public failure boundary when startup throws", async () => {
	const dir = await agentDir();
	// A regular file where the broker state directory must be makes startup throw.
	await Bun.write(path.join(dir, "sdk"), "not a directory");
	const run = brokerRun(dir);
	const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
	expect(exitCode).toBe(1);
	expect(stderr).toContain('ERROR {"code":"operation_failed"');
	// Nothing was published: the blocking file is still the only thing at the state path.
	expect(await fs.readFile(path.join(dir, "sdk"), "utf8")).toBe("not a directory");
}, 90_000);
