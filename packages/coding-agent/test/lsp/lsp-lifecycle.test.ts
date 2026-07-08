import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateClient, sendRequest, shutdownAll, waitForProjectLoaded } from "../../src/lsp/client";
import type { ServerConfig } from "../../src/lsp/types";
import { disposeAllOwnedProcesses } from "../../src/runtime/process-lifecycle";

const BUN = process.execPath;
const ORIGINAL_PATH = Bun.env.PATH;
const ORIGINAL_XDG_CONFIG_HOME = Bun.env.XDG_CONFIG_HOME;

async function tempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function serverConfig(command: string, args: string[] = []): ServerConfig {
	return {
		command,
		args,
		fileTypes: ["ts"],
		rootMarkers: [],
	};
}

async function writeFakeLspServer(dir: string): Promise<string> {
	const script = path.join(dir, "fake-lsp.ts");
	await Bun.write(
		script,
		`let buffer = Buffer.alloc(0);\nfunction write(message) {\n  const body = JSON.stringify(message);\n  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\${body}\`);\n}\nfunction handle(message) {\n  if (message.method === "initialize") {\n    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });\n    return;\n  }\n  if (message.method === "shutdown") {\n    write({ jsonrpc: "2.0", id: message.id, result: null });\n    process.exit(0);\n    return;\n  }\n}\nprocess.stdin.on("data", chunk => {\n  buffer = Buffer.concat([buffer, chunk]);\n  for (;;) {\n    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");\n    if (headerEnd === -1) return;\n    const header = buffer.subarray(0, headerEnd).toString();\n    const match = /Content-Length: (\\d+)/i.exec(header);\n    if (!match) return;\n    const length = Number(match[1]);\n    const start = headerEnd + 4;\n    const end = start + length;\n    if (buffer.length < end) return;\n    const message = JSON.parse(buffer.subarray(start, end).toString());\n    buffer = buffer.subarray(end);\n    handle(message);\n  }\n});\nsetInterval(() => {}, 1000);\n`,
	);
	return script;
}

afterEach(async () => {
	await shutdownAll();
	await disposeAllOwnedProcesses();
	delete Bun.env.PI_DISABLE_LSPMUX;
	if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
		delete Bun.env.XDG_CONFIG_HOME;
	} else {
		Bun.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
	}
	if (ORIGINAL_PATH === undefined) {
		delete Bun.env.PATH;
	} else {
		Bun.env.PATH = ORIGINAL_PATH;
	}
});

describe("LSP lifecycle behavior", () => {
	it("kill-then-immediately-reacquire evicts the dead cached client before async cleanup", async () => {
		const cwd = await tempDir("gjc-lsp-reload-");
		try {
			const script = await writeFakeLspServer(cwd);
			const config = serverConfig(BUN, [script]);
			const first = await getOrCreateClient(config, cwd, 1_000);
			const pending = sendRequest(first, "workspace/neverResponds", null, undefined, 60_000);
			const pendingSettled = pending.catch(error => error as Error);
			expect(first.pendingRequests.size).toBe(1);

			first.proc.kill();
			const second = await getOrCreateClient(config, cwd, 1_000);
			expect(await pendingSettled).toHaveProperty("message");
			await first.proc.exited.catch(() => undefined);
			const cachedAfterFirstExit = await getOrCreateClient(config, cwd, 1_000);

			expect(second).not.toBe(first);
			expect(second.proc.exitCode).toBeNull();
			expect(second.proc.killed).toBe(false);
			expect(cachedAfterFirstExit).toBe(second);
			await shutdownAll();
			const secondExitCode = await second.proc.exited;
			expect(secondExitCode).not.toBeNull();
			expect(first.pendingRequests.size).toBe(0);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("waitForProjectLoaded removes its abort listener after project loading settles", async () => {
		const controller = new AbortController();
		let activeAbortListeners = 0;
		const originalAdd = controller.signal.addEventListener.bind(controller.signal);
		const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = ((type, listener, options) => {
			if (type === "abort") activeAbortListeners += 1;
			return originalAdd(type, listener, options);
		}) as typeof controller.signal.addEventListener;
		controller.signal.removeEventListener = ((type, listener, options) => {
			if (type === "abort") activeAbortListeners -= 1;
			return originalRemove(type, listener, options);
		}) as typeof controller.signal.removeEventListener;

		const client = {
			projectLoaded: Promise.resolve(),
		} as Parameters<typeof waitForProjectLoaded>[0];

		await waitForProjectLoaded(client, controller.signal);
		expect(activeAbortListeners).toBe(0);
	});

	it("lspmux status probe clears its timeout and reaps the probe process when status hangs", async () => {
		const cwd = await tempDir("gjc-lspmux-timeout-");
		const binDir = path.join(cwd, "bin");
		const configHome = path.join(cwd, "config");
		try {
			await fs.mkdir(binDir, { recursive: true });
			await fs.mkdir(path.join(configHome, "lspmux"), { recursive: true });
			await Bun.write(path.join(configHome, "lspmux", "config.toml"), "instance_timeout = 60\n");
			const lspmux = path.join(binDir, "lspmux");
			await Bun.write(lspmux, `#!/usr/bin/env ${BUN}\nsetInterval(() => {}, 1000);\n`);
			await fs.chmod(lspmux, 0o755);
			const runner = path.join(cwd, "probe.ts");
			await Bun.write(
				runner,
				`import { detectLspmux } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/lsp/lspmux.ts"))};\nimport { liveOwnedProcessCount, disposeAllOwnedProcesses } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/runtime/process-lifecycle.ts"))};\nconst before = liveOwnedProcessCount();\nconst state = await detectLspmux();\nconst after = liveOwnedProcessCount();\nawait disposeAllOwnedProcesses();\nconsole.log(JSON.stringify({ state, before, after }));\n`,
			);
			const proc = Bun.spawn([BUN, runner], {
				cwd: path.resolve("."),
				env: {
					...Bun.env,
					PATH: ORIGINAL_PATH ? `${binDir}${path.delimiter}${ORIGINAL_PATH}` : binDir,
					XDG_CONFIG_HOME: configHome,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const result = JSON.parse(stdout) as {
				state: { available: boolean; running: boolean };
				before: number;
				after: number;
			};
			expect(result.state.available).toBe(true);
			expect(result.state.running).toBe(false);
			expect(result.after).toBe(result.before);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 3_000);
});
