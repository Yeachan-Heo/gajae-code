import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ControlServer, callEndpoint } from "../../src/harness-control-plane/control-endpoint";
import { RuntimeOwner } from "../../src/harness-control-plane/owner";
import { releaseLease } from "../../src/harness-control-plane/session-lease";
import type { HarnessSessionTransport, SessionStateSnapshot } from "../../src/harness-control-plane/session-transport";
import { readEvents, writeSessionState } from "../../src/harness-control-plane/storage";
import {
	type EventEnvelope,
	SESSION_SCHEMA_VERSION,
	type SessionHandle,
	type SessionState,
} from "../../src/harness-control-plane/types";

/** In-process RPC that lets a test push event frames through the owner's onEventFrame path. */
class FrameTransport implements HarnessSessionTransport {
	cursor = 0;
	live = true;
	closeCalls = 0;
	closeFailures = 0;
	closeFailure: (() => unknown) | null = null;
	closed = false;
	#cb: ((frame: Record<string, unknown>) => void) | null = null;
	#lastAt: string | null = null;
	async getState(): Promise<SessionStateSnapshot> {
		return { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		return { commandId: "c", ack: true };
	}
	async waitForAgentStart(): Promise<{ cursor: number } | null> {
		return null;
	}
	async close(): Promise<void> {
		this.closeCalls += 1;
		if (this.closeFailures > 0) {
			this.closeFailures -= 1;
			throw this.closeFailure?.() ?? new Error("injected transport cleanup failure");
		}
		this.closed = true;
	}
	onEventFrame(cb: (frame: Record<string, unknown>) => void): () => void {
		this.#cb = cb;
		return () => {
			this.#cb = null;
		};
	}
	isLive(): boolean {
		return this.live;
	}
	lastFrameAt(): string | null {
		return this.#lastAt;
	}
	emit(frame: Record<string, unknown>): void {
		this.cursor += 1;
		this.#lastAt = new Date().toISOString();
		// Mirror the wire: AgentSessionEvents are delivered wrapped in a canonical
		// `event` frame; control frames stay flat.
		const control = new Set([
			"ready",
			"response",
			"event",
			"extension_ui_request",
			"extension_error",
			"workflow_gate",
			"host_tool_call",
			"host_tool_cancel",
			"host_uri_request",
			"host_uri_cancel",
		]);
		const wire =
			typeof frame.type === "string" && !control.has(frame.type)
				? { type: "event", payload: { event_type: frame.type, event: frame } }
				: frame;
		this.#cb?.(wire);
	}
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 40));

async function waitForEventKind(kind: string, timeoutMs = 1_000): Promise<EventEnvelope[]> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const events = await readEvents(root, SID, 0);
		if (events.some(event => event.kind === kind)) return events;
		if (Date.now() >= deadline) return events;
		await Bun.sleep(10);
	}
}

let root: string;
const SID = "fr";
let owner: RuntimeOwner | null = null;

function seed(workspace: string): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "observing",
		harness: "gajae-code",
		handle: { sessionId: SID, harness: "gajae-code", workspace } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
	await writeSessionState(root, seed(root));
	owner = null;
});

afterEach(async () => {
	await owner?.stop();
	await rm(root, { recursive: true, force: true });
});

function obsOf(res: any) {
	return res.evidence.observation as { observedSignals: string[]; rpcLive?: boolean; lifecycle: string };
}

describe("owner frame -> observability", () => {
	it("AC-1: a tool turn surfaces tool-call/test-running + completed; single-writer events; lifecycle finalizing", async () => {
		const transport = new FrameTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport });
		const info = await owner.start();
		transport.emit({ type: "agent_start" });
		transport.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "bun test x" },
		});
		transport.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { details: { status: "ok" } },
		});
		transport.emit({ type: "agent_end" });
		const events = await waitForEventKind("rpc_agent_completed");
		const kinds = events.map(e => e.kind);
		expect(kinds).toContain("rpc_tool_started");
		expect(kinds).toContain("rpc_agent_completed");
		// single-writer: every event stamped with the owner's lease identity; cursors strictly increasing.
		expect(events.every(e => e.writer.ownerId === info.ownerId)).toBe(true);
		const cursors = events.map(e => e.cursor);
		expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
		expect(new Set(cursors).size).toBe(cursors.length);

		const res = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		const obs = obsOf(res);
		expect(obs.observedSignals).toContain("test-running");
		expect(obs.observedSignals).toContain("completed");
		expect(obs.rpcLive).toBe(true);
		const completed = events.find(e => e.kind === "rpc_agent_completed");
		expect(completed?.nextAllowedActions).toContainEqual({
			verb: "submit",
			available: false,
			reason: "lifecycle-not-idle:finalizing",
		});
		expect(obs.lifecycle).toBe("finalizing");
	});

	it("maps real partial/error tool frames without persisting raw args or output", async () => {
		const transport = new FrameTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport });
		const info = await owner.start();
		transport.emit({
			type: "tool_execution_start",
			toolCallId: "t-secret",
			toolName: "bash",
			args: { command: "bun test SECRET_COMMAND" },
		});
		transport.emit({
			type: "tool_execution_update",
			toolCallId: "t-secret",
			toolName: "bash",
			args: { command: "bun test SECRET_COMMAND" },
			partialResult: { status: "running", content: [{ type: "text", text: "SECRET_PARTIAL" }] },
		});
		transport.emit({
			type: "tool_execution_end",
			toolCallId: "t-secret",
			toolName: "bash",
			args: { command: "bun test SECRET_COMMAND" },
			result: { content: [{ type: "text", text: "SECRET_OUTPUT" }], details: { status: "failed" } },
			isError: true,
		});
		await flush();

		const events = await readEvents(root, SID, 0);
		const ended = events.find(e => e.kind === "rpc_tool_ended");
		// tool_execution_end has no args, so test-detection is by tool name -> tool-call.
		expect(ended).toMatchObject({ severity: "warn", evidence: { status: "error", signal: "tool-call" } });
		expect(events.every(e => e.writer.ownerId === info.ownerId)).toBe(true);
		const eventJson = JSON.stringify(events);
		expect(eventJson).not.toContain("SECRET_COMMAND");
		expect(eventJson).not.toContain("SECRET_PARTIAL");
		expect(eventJson).not.toContain("SECRET_OUTPUT");

		const res = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		const obsJson = JSON.stringify((res.evidence as Record<string, unknown>).observation);
		expect(obsJson).toContain("test-running");
		expect(obsJson).not.toContain("SECRET_COMMAND");
		expect(obsJson).not.toContain("SECRET_PARTIAL");
		expect(obsJson).not.toContain("SECRET_OUTPUT");
	});
	it("AC-6: repeated message_update storms cannot starve terminal observation or bloat the event log", async () => {
		const transport = new FrameTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport });
		const info = await owner.start();
		for (let turn = 0; turn < 8; turn++) {
			transport.emit({ type: "agent_start" });
			for (let i = 0; i < 500; i++)
				transport.emit({ type: "message_update", messageId: `m${turn}`, delta: "noise" });
			transport.emit({ type: "agent_end" });
			const obs = obsOf(
				(await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>,
			);
			expect(obs.observedSignals).toContain("completed");
		}

		const events = await readEvents(root, SID, 0);
		expect(events.filter(event => event.kind === "rpc_agent_completed")).toHaveLength(8);
		// Four thousand message_update frames are coalesced instead of emitted 1:1.
		expect(events.length).toBeLessThan(60);
	});

	it("AC-7: repeated poll gaps retain sticky tool-call/completed signals without settlement sleeps", async () => {
		const transport = new FrameTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport });
		const info = await owner.start();
		for (let turn = 0; turn < 8; turn++) {
			// Every frame sequence lands between observe polls.
			transport.emit({
				type: "tool_execution_start",
				toolCallId: `t${turn}`,
				toolName: "read",
				args: { path: "x" },
			});
			transport.emit({
				type: "tool_execution_end",
				toolCallId: `t${turn}`,
				toolName: "read",
				result: { details: { status: "ok" } },
			});
			transport.emit({ type: "agent_end" });
			const obs = obsOf(
				(await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>,
			);
			expect(obs.observedSignals).toContain("tool-call");
			expect(obs.observedSignals).toContain("completed");
			expect(obs.observedSignals).toContain("idle");
		}
	});

	it("latches append failure as blocking observation evidence and rejects shutdown", async () => {
		const transport = new FrameTransport();
		const runtime = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			framePersistence: {
				async appendEvent() {
					throw new Error("injected frame append failure");
				},
			},
		});
		owner = runtime;
		const info = await runtime.start();
		transport.emit({ type: "agent_start" });

		const response = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, any>;
		expect(response.ok).toBe(false);
		expect(response.state.lifecycle).toBe("blocked");
		expect(response.state.blockers).toContain("frame-persistence-failed");
		expect(obsOf(response).observedSignals).toEqual(["frame-persistence-failed"]);
		expect(response.evidence.framePumpFailure.error).toContain("injected frame append failure");
		expect(response.evidence.framePumpFailure.severity).toBe("critical");
		const repeated = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, any>;
		expect(repeated.ok).toBe(false);
		expect(repeated.state.blockers).toContain("frame-persistence-failed");
		await expect(runtime.stop()).rejects.toThrow("injected frame append failure");
		owner = null;
	});

	it("retries all cleanup stages before surfacing a latched frame-pump failure", async () => {
		const transport = new FrameTransport();
		transport.closeFailures = 1;
		let serverCloseCalls = 0;
		let serverClosed = false;
		let leaseReleaseCalls = 0;
		let leaseReleased = false;
		const runtime = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			cleanupRetryMs: 0,
			cleanupRetryLimit: 4,
			controlServerFactory(socketPath, handler) {
				const server = new ControlServer(socketPath, handler);
				const close = server.close.bind(server);
				server.close = async () => {
					serverCloseCalls += 1;
					await close();
					serverClosed = true;
					if (serverCloseCalls === 1) throw new Error("injected server cleanup failure");
				};
				return server;
			},
			leaseRelease: async (...args) => {
				leaseReleaseCalls += 1;
				if (leaseReleaseCalls === 1) throw new Error("injected lease cleanup failure");
				await releaseLease(...args);
				leaseReleased = true;
			},
			framePersistence: {
				async appendEvent() {
					throw new Error("injected frame pump failure");
				},
			},
		});
		owner = runtime;
		const info = await runtime.start();
		transport.emit({ type: "agent_start" });
		const blocked = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, any>;
		expect(blocked.state.blockers).toContain("frame-persistence-failed");

		const failure = await runtime.stop().then(
			() => null,
			error => error,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		const causes = (failure as AggregateError).errors.map(String).join("\n");
		expect(causes).toContain("injected frame pump failure");
		expect(causes).toContain("injected transport cleanup failure");
		expect(causes).toContain("injected server cleanup failure");
		expect(causes).toContain("injected lease cleanup failure");
		expect(transport.closed).toBe(true);
		expect(serverClosed).toBe(true);
		expect(leaseReleased).toBe(true);
		expect(transport.closeCalls).toBe(2);
		expect(serverCloseCalls).toBe(2);
		expect(leaseReleaseCalls).toBe(2);
		owner = null;
	});

	it("retries a lookalike frame-pump cleanup aggregate before surfacing the latched failure", async () => {
		const transport = new FrameTransport();
		transport.closeFailures = 1;
		transport.closeFailure = () =>
			new AggregateError(
				[new Error("injected lookalike transport cleanup failure")],
				"Runtime owner frame pump failed after verified cleanup: lookalike",
			);
		let serverCloseCalls = 0;
		let serverClosed = false;
		let leaseReleaseCalls = 0;
		let leaseReleased = false;
		const runtime = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			cleanupRetryMs: 0,
			cleanupRetryLimit: 4,
			controlServerFactory(socketPath, handler) {
				const server = new ControlServer(socketPath, handler);
				const close = server.close.bind(server);
				server.close = async () => {
					serverCloseCalls += 1;
					await close();
					serverClosed = true;
				};
				return server;
			},
			leaseRelease: async (...args) => {
				leaseReleaseCalls += 1;
				await releaseLease(...args);
				leaseReleased = true;
			},
			framePersistence: {
				async appendEvent() {
					throw new Error("injected latched frame pump failure");
				},
			},
		});
		owner = runtime;
		await runtime.start();
		transport.emit({ type: "agent_start" });
		await flush();

		const failure = await runtime.stop().then(
			() => null,
			error => error,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as Error).message).toContain("Runtime owner frame pump failed after verified cleanup:");
		const causes = (failure as AggregateError).errors.map(String).join("\n");
		expect(causes).toContain("injected latched frame pump failure");
		expect(causes).toContain("injected lookalike transport cleanup failure");
		expect(transport.closed).toBe(true);
		expect(serverClosed).toBe(true);
		expect(leaseReleased).toBe(true);
		expect(transport.closeCalls).toBe(2);
		expect(serverCloseCalls).toBe(1);
		expect(leaseReleaseCalls).toBe(1);
		owner = null;
	});

	it("latches terminal state-write failure before emitting completion", async () => {
		const transport = new FrameTransport();
		const runtime = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			framePersistence: {
				async writeSessionState() {
					throw new Error("injected terminal state write failure");
				},
			},
		});
		owner = runtime;
		const info = await runtime.start();
		transport.emit({ type: "agent_end" });

		const response = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, any>;
		expect(response.ok).toBe(false);
		expect(response.state.lifecycle).toBe("blocked");
		expect(response.state.blockers).toContain("frame-persistence-failed");
		expect(obsOf(response).observedSignals).toEqual(["frame-persistence-failed"]);
		expect(response.evidence.framePumpFailure.error).toContain("injected terminal state write failure");
		expect(response.evidence.framePumpFailure.severity).toBe("critical");
		expect(await readEvents(root, SID, 0)).not.toContainEqual(
			expect.objectContaining({ kind: "rpc_agent_completed" }),
		);
		await expect(runtime.stop()).rejects.toThrow("injected terminal state write failure");
		owner = null;
	});

	it("rpcLive is distinct from ownerLive (RPC death does not imply dead owner)", async () => {
		const transport = new FrameTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport });
		const info = await owner.start();
		transport.live = false; // SDK transport died; owner endpoint still serving
		const res = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		expect((res.state as Record<string, unknown>).ownerLive).toBe(true);
		expect(obsOf(res).rpcLive).toBe(false);
	});
});
