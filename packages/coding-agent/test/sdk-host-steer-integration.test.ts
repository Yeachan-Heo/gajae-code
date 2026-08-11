import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { createSdkSessionRuntimeExtension, type SessionSdkTransport } from "../src/sdk/host/session-runtime";

interface Harness {
	emit(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
	start(): Promise<void>;
	stop(): Promise<void>;
	dispatches: number;
	persistedAtDispatch?: string;
}

function createHarness(cwd: string, sessionId: string, sessionFile: string | undefined): Harness {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
	let receive: ((connectionId: string, frame: never) => void) | undefined;
	let response: Record<string, unknown> | undefined;
	let dispatches = 0;
	let persistedAtDispatch: string | undefined;
	const transport: SessionSdkTransport = {
		sessionId,
		stateRoot: path.join(cwd, ".gjc", "state"),
		token: "test-token",
		sendFrame: (_connectionId, frame) => {
			response = frame as Record<string, unknown>;
		},
		onFrame: handler => {
			receive = handler;
			return () => {
				receive = undefined;
			};
		},
		start: async () => ({ url: "memory://host-steer" }),
		stop: async () => {},
	};
	const api = {
		on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
			handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async () => {
			dispatches++;
			persistedAtDispatch = await fs.readFile(
				path.join(
					path.dirname(sessionFile ?? path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`)),
					".sdk-reconciliation",
					`${sessionId}.json`,
				),
				"utf8",
			);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, { agentDir: cwd, createTransport: () => transport });
	const base = {
		cwd,
		sessionMetadata: { kind: "main" },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getCwd: () => cwd,
			getSessionName: () => "host steer oracle",
			getUsageStatistics: () => ({}),
			getBranch: () => [],
		},
		model: { provider: "test", id: "model" },
		modelRegistry: { getAll: () => [], find: () => undefined },
		getContextUsage: () => ({ tokens: 0, contextWindow: 1, percent: 0 }),
		getThinkingLevel: () => "off",
		getActivePromptHandle: () => undefined,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
		getTranscript: () => [],
	} as unknown as ExtensionContext;
	return {
		start: async () => {
			await handlers.get("session_start")?.({ type: "session_start" }, base);
		},
		stop: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, base);
		},
		emit: async frame => {
			response = undefined;
			receive?.("client", frame as never);
			for (let attempts = 0; response === undefined && attempts < 100; attempts++) await Bun.sleep(1);
			if (!response) throw new Error("host did not respond");
			return response;
		},
		get dispatches() {
			return dispatches;
		},
		get persistedAtDispatch() {
			return persistedAtDispatch;
		},
	};
}

async function control(harness: Harness, id: string, text: string, clientRef: string) {
	return await harness.emit({ type: "control_request", id, operation: "turn.steer", input: { text, clientRef } });
}

async function query(harness: Harness, id: string, input: Record<string, unknown>) {
	return await harness.emit({ type: "query_request", id, query: "turn.steer_status", input });
}

test("production SDK host correlates durable steer replay and restart without redispatch", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-"));
	try {
		const sessionId = "host-steer-oracle";
		const sessionFile = path.join(cwd, "sessions", "session.jsonl");
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");
		const first = createHarness(cwd, sessionId, sessionFile);
		await first.start();
		const accepted = await control(first, "accept", "deliver exactly once", "  caller-ref  ");
		expect(accepted).toMatchObject({ ok: true, result: { accepted: true, clientRef: "caller-ref" } });
		const correlation = (accepted.result ?? {}) as Record<string, unknown>;
		expect(correlation.commandId).toBeString();
		expect(correlation.turnId).toBeString();
		expect(first.persistedAtDispatch).toContain('"status":"dispatching"');
		expect(await control(first, "replay", "deliver exactly once", "caller-ref")).toMatchObject({
			ok: true,
			result: { commandId: correlation.commandId, turnId: correlation.turnId },
		});
		expect(first.dispatches).toBe(1);
		expect(await control(first, "conflict", "different text", "caller-ref")).toMatchObject({
			ok: false,
		});
		expect(first.dispatches).toBe(1);
		expect(await query(first, "by-ref", { clientRef: "caller-ref" })).toMatchObject({
			ok: true,
			result: { commandId: correlation.commandId, turnId: correlation.turnId },
		});
		expect(
			await query(first, "by-pair", { commandId: correlation.commandId, turnId: correlation.turnId }),
		).toMatchObject({
			ok: true,
			result: { clientRef: "caller-ref" },
		});
		const persisted = await fs.readFile(
			path.join(path.dirname(sessionFile), ".sdk-reconciliation", `${sessionId}.json`),
			"utf8",
		);
		expect(persisted).not.toContain("deliver exactly once");
		expect(persisted).not.toContain("different text");
		await first.stop();

		const restarted = createHarness(cwd, sessionId, sessionFile);
		await restarted.start();
		expect(await query(restarted, "restart", { clientRef: "caller-ref" })).toMatchObject({
			ok: true,
			result: { status: "uncertain", error: { code: "process_restart_uncertain" } },
		});
		expect(await control(restarted, "restart-replay", "deliver exactly once", "caller-ref")).toMatchObject({
			ok: true,
			result: { accepted: false, status: "uncertain" },
		});
		expect(restarted.dispatches).toBe(0);
		await restarted.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("production SDK host persists steer reconciliation under state root when session file is undefined", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-steer-state-root-"));
	try {
		const sessionId = "in-memory-host-steer";
		const harness = createHarness(cwd, sessionId, undefined);
		await harness.start();
		const accepted = await control(harness, "accept", "private steer text", "state-root-ref");
		expect(accepted).toMatchObject({ ok: true, result: { accepted: true, clientRef: "state-root-ref" } });
		const persisted = await fs.readFile(
			path.join(cwd, ".gjc", "state", ".sdk-reconciliation", `${sessionId}.json`),
			"utf8",
		);
		expect(persisted).toContain('"status":"accepted"');
		expect(persisted).not.toContain("private steer text");
		await harness.stop();
		const restarted = createHarness(cwd, sessionId, undefined);
		await restarted.start();
		expect(await query(restarted, "restart", { clientRef: "state-root-ref" })).toMatchObject({
			ok: true,
			result: { status: "uncertain", error: { code: "process_restart_uncertain" } },
		});
		await restarted.stop();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
