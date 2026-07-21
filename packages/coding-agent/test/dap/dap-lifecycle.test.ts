import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DapClient } from "../../src/dap/client";
import { DapSessionManager } from "../../src/dap/session";
import type { DapCapabilities, DapClientState, DapEventMessage, DapResolvedAdapter } from "../../src/dap/types";
import {
	disposeAllOwnedProcesses,
	liveOwnedProcessCount,
	spawnOwnedProcess,
} from "../../src/runtime/process-lifecycle";

const BUN = process.execPath;

const SOCKET_ADAPTER: DapResolvedAdapter = {
	name: "fake-socket",
	command: BUN,
	args: [],
	resolvedCommand: BUN,
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "socket",
};

const STDIO_ADAPTER: DapResolvedAdapter = {
	...SOCKET_ADAPTER,
	name: "fake-stdio",
	connectMode: "stdio",
};

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

class RunInTerminalFakeClient {
	readonly adapter = STDIO_ADAPTER;
	readonly cwd: string;
	readonly proc: DapClientState["proc"];
	readonly #handlers = new Map<string, Set<DapEventHandler>>();
	#reverseHandlers = new Map<string, DapReverseRequestHandler>();
	#alive = true;
	readonly #exited = Promise.withResolvers<number>();

	constructor(cwd: string) {
		this.cwd = cwd;
		this.proc = {
			exited: this.#exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				this.#alive = false;
				this.#exited.resolve(0);
				return true;
			},
		} as unknown as DapClientState["proc"];
	}

	async initialize(): Promise<DapCapabilities> {
		queueMicrotask(() => this.#emit("initialized", {}));
		return { supportsConfigurationDoneRequest: true };
	}

	async sendRequest(command: string): Promise<unknown> {
		if (command === "launch") {
			const handler = this.#reverseHandlers.get("runInTerminal");
			if (!handler) throw new Error("runInTerminal handler was not registered");
			return handler({ args: [BUN, "-e", "setInterval(() => {}, 1000)"], cwd: this.cwd });
		}
		if (command === "configurationDone") return {};
		if (command === "disconnect") {
			this.#alive = false;
			this.#exited.resolve(0);
			return {};
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		if (event === "stopped" || event === "terminated" || event === "exited") {
			return Promise.reject(new Error(`DAP event ${event} timed out after 1ms`));
		}
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		const handlers = this.#handlers.get(event) ?? new Set<DapEventHandler>();
		handlers.add(handler);
		this.#handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
		this.#reverseHandlers.set(command, handler);
		return () => this.#reverseHandlers.delete(command);
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.#alive = false;
		this.#exited.resolve(0);
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#handlers.get(event) ?? []) {
			void handler(body, message);
		}
	}
}

async function tempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(async () => {
	await disposeAllOwnedProcesses();
});

describe("DAP lifecycle behavior", () => {
	it("socket-mode startup timeout disposes the adapter process", async () => {
		const cwd = await tempDir("gjc-dap-socket-timeout-");
		try {
			const script = path.join(cwd, "adapter.ts");
			await Bun.write(script, "setInterval(() => {}, 1000);\n");
			const before = liveOwnedProcessCount();

			await expect(
				DapClient.spawn({
					adapter: { ...SOCKET_ADAPTER, args: [script] },
					cwd,
				}),
			).rejects.toThrow(/did not connect within 10s|timed out|Connection refused|ENOENT|Socket not ready/);

			expect(liveOwnedProcessCount()).toBe(before);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 15_000);

	it.skipIf(process.platform !== "linux")("socket-mode Unix startup failure unlinks the temporary .sock", async () => {
		const cwd = await tempDir("gjc-dap-unix-socket-timeout-");
		try {
			const script = path.join(cwd, "adapter.ts");
			const socketPathMarker = path.join(cwd, "socket-path");

			await Bun.write(
				script,
				`const listen = process.argv.find(arg => arg.startsWith("--listen=unix:"));\nif (!listen) throw new Error("missing listen arg");\nconst socketPath = listen.slice("--listen=unix:".length);\nawait Bun.write(${JSON.stringify(socketPathMarker)}, socketPath);\nawait Bun.write(socketPath, "not a socket");\nsetInterval(() => {}, 1000);\n`,
			);

			await expect(
				DapClient.spawn({
					adapter: { ...SOCKET_ADAPTER, args: [script] },
					cwd,
				}),
			).rejects.toThrow();

			const socketPath = await Bun.file(socketPathMarker).text();
			expect(await Bun.file(socketPath).exists()).toBe(false);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"dispose reaps adapter child process groups through owned lifecycle",
		async () => {
			const cwd = await tempDir("gjc-dap-dispose-owner-");
			try {
				const marker = path.join(cwd, "child-ready");
				const script = path.join(cwd, "adapter.ts");
				await Bun.write(
					script,
					`const child = Bun.spawn([process.execPath, "-e", "await Bun.write(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", ${JSON.stringify(marker)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });\nsetInterval(() => {}, 1000);\n`,
				);
				const client = await DapClient.spawn({ adapter: { ...STDIO_ADAPTER, args: [script] }, cwd });
				await Bun.sleep(1_000);
				expect(await Bun.file(marker).exists()).toBe(true);

				await client.dispose();
				expect(client.proc.killed).toBe(true);
				expect(liveOwnedProcessCount()).toBe(0);
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"tracks runInTerminal debuggees as owned processes and reaps only the session child on dispose",
		async () => {
			const cwd = await tempDir("gjc-dap-runterminal-");
			const unrelated = spawnOwnedProcess([BUN, "-e", "setInterval(() => {}, 1000)"], {
				name: "dap-test:unrelated",
			});
			try {
				const manager = new DapSessionManager();
				const fake = new RunInTerminalFakeClient(cwd);
				const originalSpawn = DapClient.spawn;
				DapClient.spawn = async () => fake as unknown as DapClient;
				try {
					const before = liveOwnedProcessCount();
					const summary = await manager.launch({ adapter: STDIO_ADAPTER, program: "fake", cwd }, undefined, 25);
					expect(liveOwnedProcessCount()).toBeGreaterThan(before);

					await manager.terminate(undefined, 25);
					expect(manager.listSessions().some(session => session.id === summary.id)).toBe(false);
					expect(unrelated.child.exitCode).toBeNull();
					expect(liveOwnedProcessCount()).toBe(1);
				} finally {
					DapClient.spawn = originalSpawn;
				}
			} finally {
				await unrelated.dispose();
				await unrelated.awaitExit({ timeoutMs: 1_000 });
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	);
});
