import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";

const roots = new Set<string>();
const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-isolation-"));
	roots.add(root);
	return root;
}

async function stopBroker(agentDir: string): Promise<void> {
	const discovery = await readBrokerDiscovery(agentDir);
	if (!discovery) return;
	try {
		process.kill(discovery.pid, "SIGTERM");
	} catch {}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(discovery.pid, 0);
			await Bun.sleep(25);
		} catch {
			return;
		}
	}
	try {
		process.kill(discovery.pid, "SIGKILL");
	} catch {}
}

afterEach(async () => {
	for (const root of roots) {
		await stopBroker(path.join(root, "agent"));
		await fs.rm(root, { recursive: true, force: true });
	}
	roots.clear();
});

it("starts a fresh detached source broker without loading hostile cwd bunfig or dotenv", async () => {
	const root = await tempRoot();
	const hostileCwd = path.join(root, "hostile project ü");
	const agentDir = path.join(root, "agent");
	const preloadSentinel = path.join(root, "preload-sentinel");
	const dotenvSentinel = path.join(root, "dotenv-sentinel");
	const preload = path.join(root, "preload.ts");
	const pathSentinel = path.join(root, "path-sentinel");
	const hostileBin = path.join(root, "hostile-bin");
	await fs.mkdir(hostileCwd, { recursive: true });
	await fs.mkdir(hostileBin, { recursive: true });
	const fakeBun = path.join(hostileBin, process.platform === "win32" ? "bun.cmd" : "bun");
	await Bun.write(
		fakeBun,
		process.platform === "win32"
			? `@echo path-hijack>${JSON.stringify(pathSentinel)}\r\n`
			: `#!/bin/sh\nprintf path-hijack > ${JSON.stringify(pathSentinel)}\n`,
	);
	if (process.platform !== "win32") await fs.chmod(fakeBun, 0o755);
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(hostileCwd, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
	await Bun.write(path.join(hostileCwd, ".env"), "GJC_2178_DOTENV=dotenv-loaded\n");
	await Bun.write(
		preload,
		[
			`await Bun.write(${JSON.stringify(preloadSentinel)}, "preload-loaded");`,
			`if (process.env.GJC_2178_DOTENV) await Bun.write(${JSON.stringify(dotenvSentinel)}, process.env.GJC_2178_DOTENV);`,
		].join("\n"),
	);

	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"--config=/dev/null",
			cliEntrypoint,
			"daemon",
			"session",
			"global",
			"--op=session.list",
			"--json-input={}",
			`--agent-dir=${agentDir}`,
		],
		{
			cwd: hostileCwd,
			env: {
				...process.env,
				BUN_OPTIONS: "--no-env-file --config=/dev/null",
				PI_COMPILED: "1",
				GJC_COMPILED: "1",
				PATH: `${hostileBin}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	const response = JSON.parse(stdout.trim()) as { ok?: boolean; result?: { sessions?: unknown[] } };
	expect(response.ok).toBe(true);
	expect(response.result?.sessions).toEqual([]);
	expect(await readBrokerDiscovery(agentDir)).not.toBeNull();
	expect(await Bun.file(preloadSentinel).exists()).toBe(false);
	expect(await Bun.file(dotenvSentinel).exists()).toBe(false);
	expect(await Bun.file(pathSentinel).exists()).toBe(false);
});

it("starts the default source session host with isolated bootstrap policy and workspace cwd", async () => {
	const root = await tempRoot();
	const workspace = path.join(root, "workspace ü");
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(workspace, ".gjc", "state");
	const sentinel = path.join(root, "host-preload-sentinel");
	const preload = path.join(root, "host-preload.ts");
	await fs.mkdir(workspace, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(workspace, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
	await Bun.write(preload, `await Bun.write(${JSON.stringify(sentinel)}, process.cwd());\n`);
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	delete process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const created = await broker.handleRequest(
			"session.create",
			{ cwd: workspace, stateRoot, readinessTimeoutMs: 10_000 },
			"source-host-isolation",
		);
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error(created.error.message);
		const sessionId = (created.result as { sessionId?: unknown }).sessionId;
		expect(typeof sessionId).toBe("string");
		if (typeof sessionId !== "string") throw new Error("session.create did not return a session id");
		expect(await Bun.file(sentinel).exists()).toBe(false);
		expect(await broker.handleRequest("session.close", { sessionId }, "source-host-close")).toMatchObject({
			ok: true,
			result: { sessionId },
		});
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
	}
}, 30_000);
