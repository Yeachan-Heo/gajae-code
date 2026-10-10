import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
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

function brokerRun(dir: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const env = { ...process.env };
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
