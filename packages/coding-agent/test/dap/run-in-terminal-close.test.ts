/**
 * A runInTerminal spawn that is still resolving its cwd must not start after
 * the session begins teardown.
 */
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DapClient } from "../../src/dap/client";
import { DapSessionManager, runInTerminalTestHooks } from "../../src/dap/session";
import type { DapCapabilities, DapClientState, DapResolvedAdapter } from "../../src/dap/types";
import { liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";

const BUN = process.execPath;

const ADAPTER: DapResolvedAdapter = {
	name: "fake-stdio",
	command: BUN,
	args: [],
	resolvedCommand: BUN,
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
};

function fakeClient(cwd: string, args: string[], holdDisconnect?: Promise<void>) {
	const exited = Promise.withResolvers<number>();
	const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
	return {
		adapter: ADAPTER,
		cwd,
		proc: {
			exited: exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				exited.resolve(0);
				return true;
			},
		} as unknown as DapClientState["proc"],
		async initialize(): Promise<DapCapabilities> {
			return { supportsConfigurationDoneRequest: true };
		},
		async sendRequest(command: string): Promise<unknown> {
			if (command === "launch") {
				const handler = handlers.get("runInTerminal");
				if (!handler) throw new Error("runInTerminal handler was not registered");
				return handler({ args, cwd });
			}
			if (command === "disconnect" && holdDisconnect) await holdDisconnect;
			return {};
		},
		waitForEvent(event: string): Promise<unknown> {
			return Promise.reject(new Error(`DAP event ${event} timed out after 1ms`));
		},
		onEvent(): () => void {
			return () => undefined;
		},
		onReverseRequest(command: string, next: (raw: unknown) => Promise<unknown>): () => void {
			handlers.set(command, next);
			return () => handlers.delete(command);
		},
		isAlive(): boolean {
			return true;
		},
		async dispose(): Promise<void> {
			exited.resolve(0);
		},
	};
}

it.skipIf(process.platform === "win32")("rejects runInTerminal when the session closes before spawn", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dap-runterminal-close-"));
	const marker = path.join(cwd, "ran");
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	runInTerminalTestHooks.beforeSpawn = async () => {
		entered.resolve();
		await gate.promise;
	};
	const originalSpawn = DapClient.spawn;
	try {
		const manager = new DapSessionManager();
		DapClient.spawn = async () =>
			fakeClient(cwd, [BUN, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`]) as unknown as DapClient;
		const before = liveOwnedProcessCount();
		const pendingLaunch = manager.launch({ adapter: ADAPTER, program: "fake", cwd }, undefined, 25);
		await entered.promise;
		const pendingTerminate = manager.terminate(undefined, 25);
		gate.resolve();
		await pendingTerminate;
		await expect(pendingLaunch).rejects.toThrow(/session is closed/);
		expect(liveOwnedProcessCount()).toBe(before);
		expect(await Bun.file(marker).exists()).toBe(false);
	} finally {
		DapClient.spawn = originalSpawn;
		runInTerminalTestHooks.beforeSpawn = undefined;
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")(
	"rejects runInTerminal while terminate is still waiting on disconnect",
	async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dap-runterminal-disconnect-"));
		const marker = path.join(cwd, "ran");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const disconnect = Promise.withResolvers<void>();
		runInTerminalTestHooks.beforeSpawn = async () => {
			entered.resolve();
			await gate.promise;
		};
		const originalSpawn = DapClient.spawn;
		try {
			const manager = new DapSessionManager();
			DapClient.spawn = async () =>
				fakeClient(
					cwd,
					[BUN, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`],
					disconnect.promise,
				) as unknown as DapClient;
			const before = liveOwnedProcessCount();
			const pendingLaunch = manager.launch({ adapter: ADAPTER, program: "fake", cwd }, undefined, 25);
			await entered.promise;
			const pendingTerminate = manager.terminate(undefined, 25);
			gate.resolve();
			await expect(pendingLaunch).rejects.toThrow(/session is closed/);
			expect(liveOwnedProcessCount()).toBe(before);
			expect(await Bun.file(marker).exists()).toBe(false);
			disconnect.resolve();
			await pendingTerminate;
			expect(manager.getActiveSession()).toBeNull();
		} finally {
			DapClient.spawn = originalSpawn;
			runInTerminalTestHooks.beforeSpawn = undefined;
			disconnect.resolve();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	},
);
