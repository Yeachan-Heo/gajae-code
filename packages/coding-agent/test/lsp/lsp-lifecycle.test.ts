import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getOrCreateClient,
	notifySaved,
	refreshFile,
	releaseLspScope,
	retainLspScope,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	shutdownAll,
	waitForProjectLoaded,
} from "../../src/lsp/client";
import type { LspClient, ServerConfig } from "../../src/lsp/types";
import { disposeAllOwnedProcesses, liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";

const BUN = process.execPath;
const ORIGINAL_PATH = Bun.env.PATH;
const ORIGINAL_XDG_CONFIG_HOME = Bun.env.XDG_CONFIG_HOME;

async function tempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected promise to reject");
}

function serverConfig(command: string, args: string[] = []): ServerConfig {
	return {
		command,
		args,
		fileTypes: ["ts"],
		rootMarkers: [],
	};
}

function createTestClient(stdin: { write: (message: string) => unknown; flush: () => Promise<void> }): LspClient {
	return {
		name: "test-lsp",
		cwd: "/tmp/test-lsp",
		config: serverConfig("test-lsp"),
		proc: { stdin } as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

function parseWrittenMessage(message: string): { method?: string; params?: unknown } {
	const separator = message.indexOf("\r\n\r\n");
	return JSON.parse(message.slice(separator + 4)) as { method?: string; params?: unknown };
}

async function writeFakeLspServer(dir: string, options?: { initDelayMs?: number }): Promise<string> {
	const script = path.join(dir, "fake-lsp.ts");
	await Bun.write(
		script,
		`let buffer = Buffer.alloc(0);\nfunction write(message) {\n  const body = JSON.stringify(message);\n  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\${body}\`);\n}\nfunction handle(message) {\n  if (message.method === "initialize") {\n    setTimeout(() => {\n      write({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });\n    }, ${options?.initDelayMs ?? 0});\n    return;\n  }\n  if (message.method === "shutdown") {\n    write({ jsonrpc: "2.0", id: message.id, result: null });\n    process.exit(0);\n    return;\n  }\n}\nprocess.stdin.on("data", chunk => {\n  buffer = Buffer.concat([buffer, chunk]);\n  for (;;) {\n    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");\n    if (headerEnd === -1) return;\n    const header = buffer.subarray(0, headerEnd).toString();\n    const match = /Content-Length: (\\d+)/i.exec(header);\n    if (!match) return;\n    const length = Number(match[1]);\n    const start = headerEnd + 4;\n    const end = start + length;\n    if (buffer.length < end) return;\n    const message = JSON.parse(buffer.subarray(start, end).toString());\n    buffer = buffer.subarray(end);\n    handle(message);\n  }\n});\nsetInterval(() => {}, 1000);\n`,
	);
	return script;
}

afterEach(async () => {
	await shutdownAll();
	await disposeAllOwnedProcesses();
	vi.restoreAllMocks();
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
	it("keeps idle cleanup isolated when a sibling profile disables its timeout", async () => {
		const cwd = await tempDir("gjc-lsp-idle-scope-");
		const profileA = path.join(cwd, "profile-a");
		const profileB = path.join(cwd, "profile-b");
		let idleSweep: (() => void) | undefined;
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
			callback: (...args: never[]) => void,
		) => {
			if (typeof callback === "function") idleSweep = callback as () => void;
			return {} as NodeJS.Timeout;
		}) as unknown as typeof setInterval);
		try {
			const script = await writeFakeLspServer(cwd);
			const config = serverConfig(BUN, [script]);
			const clientA = await getOrCreateClient(config, cwd, 1_000, profileA);
			const clientB = await getOrCreateClient(config, cwd, 1_000, profileB);

			clientA.lastActivity = Date.now() - 2_000;
			clientB.lastActivity = Date.now();
			setIdleTimeout(1_000, cwd, profileA);
			setIdleTimeout(undefined, cwd, profileB);
			expect(idleSweep).toBeDefined();

			idleSweep?.();
			await Bun.sleep(50);
			expect(clientA.proc.exitCode).not.toBeNull();
			expect(clientB.proc.exitCode).toBeNull();
		} finally {
			setIdleTimeout(undefined, cwd, profileA);
			setIdleTimeout(undefined, cwd, profileB);
			intervalSpy.mockRestore();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

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

	it("releasing one retained profile scope preserves a sibling client's pending requests", async () => {
		const cwd = await tempDir("gjc-lsp-scope-release-");
		const profileA = path.join(cwd, "profile-a");
		const profileB = path.join(cwd, "profile-b");
		try {
			const script = await writeFakeLspServer(cwd);
			const config = serverConfig(BUN, [script]);
			retainLspScope(cwd, profileA);
			retainLspScope(cwd, profileB);
			const first = await getOrCreateClient(config, cwd, 1_000, profileA);
			const second = await getOrCreateClient(config, cwd, 1_000, profileB);
			const firstPending = sendRequest(first, "workspace/neverResponds", null, undefined, 60_000).catch(
				error => error,
			);
			const secondPending = sendRequest(second, "workspace/neverResponds", null, undefined, 60_000).catch(
				error => error,
			);
			expect(first.pendingRequests.size).toBe(1);
			expect(second.pendingRequests.size).toBe(1);

			await releaseLspScope(cwd, profileA);
			expect(await firstPending).toBeInstanceOf(Error);
			expect(first.proc.exitCode).not.toBeNull();
			expect(second.proc.exitCode).toBeNull();
			expect(second.pendingRequests.size).toBe(1);

			await releaseLspScope(cwd, profileB);
			expect(await secondPending).toBeInstanceOf(Error);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it.each([
		"EPIPE",
		"ERR_STREAM_DESTROYED",
	] as const)("terminalizes and evicts a client when its owned stdin sink reports %s", async code => {
		const cwd = await tempDir("gjc-lsp-peer-close-");
		try {
			const script = await writeFakeLspServer(cwd);
			const config = serverConfig(BUN, [script]);
			const first = await getOrCreateClient(config, cwd, 1_000);
			const serializationError = Object.assign(new Error("serialization failed"), { code });
			const params = {
				toJSON(): never {
					throw serializationError;
				},
			};
			expect(await captureError(sendNotification(first, "test/serialization", params))).toBe(serializationError);

			const pending = captureError(sendRequest(first, "workspace/neverResponds", null, undefined, 60_000));
			expect(first.pendingRequests.size).toBe(1);
			await Bun.sleep(10);

			const unrelatedSinkError = Object.assign(new Error("unrelated sink failure"), { code: "EIO" });
			Object.defineProperty(first.proc.stdin, "flush", {
				configurable: true,
				value: async () => {
					throw unrelatedSinkError;
				},
			});
			expect(await captureError(sendNotification(first, "test/unrelatedFailure", {}))).toBe(unrelatedSinkError);
			expect(first.pendingRequests.size).toBe(1);

			const peerClosedError = Object.assign(new Error("peer closed"), { code });
			Object.defineProperty(first.proc.stdin, "flush", {
				configurable: true,
				value: async () => {
					throw peerClosedError;
				},
			});
			await sendNotification(first, "test/afterClose", {});
			const pendingError = await pending;
			expect(pendingError.message).toBe("LSP transport closed");
			expect(pendingError.cause).toBe(peerClosedError);
			expect(first.pendingRequests.size).toBe(0);

			const staleRequestError = await captureError(sendRequest(first, "test/stale", null));
			expect(staleRequestError).toBe(pendingError);

			const second = await getOrCreateClient(config, cwd, 1_000);
			expect(second).not.toBe(first);
			expect(second.proc.exitCode).toBeNull();
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

	it("serializes refresh/save and skips a save after the URI is closed for a replacement client", async () => {
		const cwd = await tempDir("gjc-lsp-save-replacement-");
		try {
			const filePath = path.join(cwd, "example.ts");
			await Bun.write(filePath, "export const value = 1;\n");
			const uri = `file://${filePath}`;
			const writes: Array<{ method?: string; params?: unknown }> = [];
			const { promise: refreshGate, resolve: releaseRefresh } = Promise.withResolvers<void>();
			const { promise: refreshWriteStarted, resolve: refreshStarted } = Promise.withResolvers<void>();
			const stdin = {
				write: async (message: string) => {
					const parsed = parseWrittenMessage(message);
					writes.push(parsed);
					if (parsed.method === "textDocument/didChange") {
						refreshStarted();
						await refreshGate;
					}
				},
				flush: async () => {},
			};
			const client = createTestClient(stdin);
			client.openFiles.set(uri, { version: 1, languageId: "typescript" });

			const refreshPromise = refreshFile(client, filePath);
			await refreshWriteStarted;
			const savePromise = notifySaved(client, filePath);
			const replacementWrites: Array<{ method?: string; params?: unknown }> = [];
			const replacementStdin = {
				write: async (message: string) => {
					replacementWrites.push(parseWrittenMessage(message));
				},
				flush: async () => {},
			};
			const replacementClient = createTestClient(replacementStdin);
			replacementClient.openFiles.set(uri, { version: 1, languageId: "typescript" });
			await notifySaved(replacementClient, filePath);

			// The old generation is closed while its save waits behind refresh. A
			// replacement client may track the same URI, but must not make the old
			// client's queued save eligible to send.
			client.openFiles.delete(uri);
			releaseRefresh();

			await Promise.all([refreshPromise, savePromise]);
			expect(writes.filter(message => message.method === "textDocument/didSave")).toHaveLength(1);
			expect(replacementWrites.filter(message => message.method === "textDocument/didSave")).toHaveLength(1);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("checks cancellation again immediately before sending didSave", async () => {
		const cwd = await tempDir("gjc-lsp-save-abort-before-write-");
		try {
			const filePath = path.join(cwd, "example.ts");
			await Bun.write(filePath, "export const value = 1;\n");
			const uri = `file://${filePath}`;
			const controller = new AbortController();
			const writes: Array<{ method?: string; params?: unknown }> = [];
			const stdin = {
				write: async (message: string) => {
					writes.push(parseWrittenMessage(message));
				},
				flush: async () => {},
			};
			const client = createTestClient(stdin);
			class AbortOnHasMap extends Map<string, { version: number; languageId: string }> {
				has(key: string) {
					const present = super.has(key);
					controller.abort();
					return present;
				}
			}
			client.openFiles = new AbortOnHasMap([[uri, { version: 1, languageId: "typescript" }]]);

			await expect(notifySaved(client, filePath, controller.signal)).rejects.toThrow();
			await Bun.sleep(0);
			expect(writes.filter(message => message.method === "textDocument/didSave")).toHaveLength(0);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("returns a cancelled save without waiting for a stalled predecessor", async () => {
		const cwd = await tempDir("gjc-lsp-save-cancel-");
		try {
			const filePath = path.join(cwd, "example.ts");
			await Bun.write(filePath, "export const value = 1;\n");
			const uri = `file://${filePath}`;
			const { promise: refreshGate, resolve: releaseRefresh } = Promise.withResolvers<void>();
			const { promise: refreshWriteStarted, resolve: refreshStarted } = Promise.withResolvers<void>();
			const writes: Array<{ method?: string; params?: unknown }> = [];
			const stdin = {
				write: async (message: string) => {
					const parsed = parseWrittenMessage(message);
					writes.push(parsed);
					if (parsed.method === "textDocument/didChange") {
						refreshStarted();
						await refreshGate;
					}
				},
				flush: async () => {},
			};
			const client = createTestClient(stdin);
			client.openFiles.set(uri, { version: 1, languageId: "typescript" });

			const refreshPromise = refreshFile(client, filePath);
			await refreshWriteStarted;
			const controller = new AbortController();
			const savePromise = notifySaved(client, filePath, controller.signal);
			controller.abort();

			const outcome = await Promise.race([
				savePromise.then(
					() => "resolved" as const,
					() => "rejected" as const,
				),
				Bun.sleep(100).then(() => "timeout" as const),
			]);
			expect(outcome).toBe("rejected");

			releaseRefresh();
			await refreshPromise;
			expect(writes.filter(message => message.method === "textDocument/didSave")).toHaveLength(1);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
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
			// Hermetic probe: bun test shares one process across test files, so
			// ambient state left by another file must not reach this probe.
			// (1) A disable flag in Bun.env (GJC_DISABLE_LSPMUX / PI_DISABLE_LSPMUX)
			//     would short-circuit detectLspmux() to available:false.
			// (2) A drifted process.cwd() (an earlier test that chdir'd into a temp
			//     dir without restoring) would make the trust root a temp ancestor of
			//     binDir, so the external lspmux is misjudged project-controlled and
			//     available flips false. Pin cwd to this in-repo test dir so the trust
			//     root resolves to the repo and binDir (under os.tmpdir()) stays external.
			const probeEnv: Record<string, string | undefined> = {
				...Bun.env,
				PATH: ORIGINAL_PATH ? `${binDir}${path.delimiter}${ORIGINAL_PATH}` : binDir,
				XDG_CONFIG_HOME: configHome,
			};
			delete probeEnv.GJC_DISABLE_LSPMUX;
			delete probeEnv.PI_DISABLE_LSPMUX;
			const proc = Bun.spawn([BUN, runner], {
				cwd: import.meta.dir,
				env: probeEnv,
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

async function writeBusyThenDyingLspServer(dir: string): Promise<string> {
	// Answers `initialize`, then blocks its event loop without consuming stdin
	// (like a server busy analyzing a large file), then exits while the client
	// still has a large in-flight write queued in the socket buffer.
	const script = path.join(dir, "busy-lsp.ts");
	await Bun.write(
		script,
		`let buffer = Buffer.alloc(0);\nfunction write(message) {\n  const body = JSON.stringify(message);\n  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\${body}\`);\n}\nprocess.stdin.on("data", chunk => {\n  buffer = Buffer.concat([buffer, chunk]);\n  for (;;) {\n    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");\n    if (headerEnd === -1) return;\n    const header = buffer.subarray(0, headerEnd).toString();\n    const match = /Content-Length: (\\d+)/i.exec(header);\n    if (!match) return;\n    const length = Number(match[1]);\n    const start = headerEnd + 4;\n    const end = start + length;\n    if (buffer.length < end) return;\n    const message = JSON.parse(buffer.subarray(start, end).toString());\n    buffer = buffer.subarray(end);\n    if (message.method === "initialize") {\n      write({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });\n      // Immediately simulate a server that stops servicing stdin (like one\n      // busy analyzing a large file): the reply is already in the kernel pipe\n      // buffer, so blocking the event loop keeps stdin unconsumed and the\n      // client's next large write stays pending in the kernel socket buffer.\n      const until = Date.now() + 3000;\n      while (Date.now() < until) {}\n      process.exit(1);\n    }\n  }\n});\nsetInterval(() => {}, 1000);\n`,
	);
	return script;
}

describe("LSP transport write failures", () => {
	it("a large pending write to a dying server is terminalized, not an unhandled rejection", async () => {
		const cwd = await tempDir("gjc-lsp-epipe-");
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const script = await writeBusyThenDyingLspServer(cwd);
			const config = serverConfig(BUN, [script]);
			const client = await getOrCreateClient(config, cwd, 5_000);

			// Larger than the kernel socket buffer so FileSink.write() returns a
			// promise (backpressure) that stays pending while the server is busy.
			const largeParams = { text: "x".repeat(512 * 1024) };
			const largeWrite = sendNotification(client, "textDocument/didChange", largeParams);
			await Bun.sleep(100);

			// Kill the server while the write is still pending, exactly like a
			// language server that crashes mid-analysis with a large didOpen or
			// didChange queued: the pending write fails with EPIPE.
			client.proc.kill();
			await largeWrite;
			await Bun.sleep(200);

			expect(unhandled).toEqual([]);

			// The transport must be terminalized: notifications resolve quietly
			// and later requests reject with the mapped error, not the raw one.
			await sendNotification(client, "test/afterExit", {});
			const staleRequestError = await captureError(sendRequest(client, "test/stale", null));
			expect(staleRequestError.message).toBe("LSP transport closed");
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 10_000);

	it("concurrent callers during a slow initialize share the initialized client, never an uninitialized one", async () => {
		const cwd = await tempDir("gjc-lsp-slow-init-");
		try {
			const script = await writeFakeLspServer(cwd, { initDelayMs: 150 });
			const config = serverConfig(BUN, [script]);

			const firstPromise = getOrCreateClient(config, cwd, 5_000);
			let secondResolvedBeforeHandshake = false;
			const secondPromise = getOrCreateClient(config, cwd, 5_000).then(client => {
				secondResolvedBeforeHandshake = client.serverCapabilities === undefined;
				return client;
			});
			const [first, second] = await Promise.all([firstPromise, secondPromise]);

			expect(second).toBe(first);
			expect(secondResolvedBeforeHandshake).toBe(false);
			expect(second.serverCapabilities).toBeDefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 10_000);

	it("concurrent callers observe the same failure when the server dies during initialize", async () => {
		const cwd = await tempDir("gjc-lsp-dying-init-");
		try {
			// A server that exits immediately, like a broken launcher on PATH
			// (e.g. a Python LSP stub whose interpreter can no longer import it).
			const script = path.join(cwd, "dying-lsp.ts");
			await Bun.write(script, "console.error(\"No module named 'fake-lsp'\");\nprocess.exit(1);\n");
			const config = serverConfig(BUN, [script]);

			const firstPromise = getOrCreateClient(config, cwd, 5_000).catch(error => error);
			const secondPromise = getOrCreateClient(config, cwd, 5_000).catch(error => error);
			const [first, second] = await Promise.all([firstPromise, secondPromise]);

			expect(first).toBeInstanceOf(Error);
			expect(second).toBe(first);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 10_000);

	it("shutdownAll disposes an in-flight initializer and prevents cache resurrection", async () => {
		const cwd = await tempDir("gjc-lsp-shutdown-init-");
		try {
			const script = await writeFakeLspServer(cwd, { initDelayMs: 500 });
			const config = serverConfig(BUN, [script]);
			const before = liveOwnedProcessCount();
			const initializing = getOrCreateClient(config, cwd, 5_000);
			await Bun.sleep(50);
			await shutdownAll();
			await expect(initializing).rejects.toThrow("LSP client shutdown");
			await Bun.sleep(100);
			expect(liveOwnedProcessCount()).toBe(before);

			const retry = await getOrCreateClient(config, cwd, 5_000);
			expect(retry.proc.exitCode).toBeNull();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
