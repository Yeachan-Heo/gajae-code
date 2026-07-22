import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ControlServer, callEndpoint } from "../../src/harness-control-plane/control-endpoint";
import { RuntimeOwner, resolveOwner, resolveOwnerLive } from "../../src/harness-control-plane/owner";
import { acquireLease, readLease, releaseLease } from "../../src/harness-control-plane/session-lease";
import type {
	HarnessSessionTransport,
	HarnessSessionTransportCloseContext,
	SessionStateSnapshot,
} from "../../src/harness-control-plane/session-transport";
import {
	controlSocketPath,
	readEvents,
	readReceiptIndex,
	readSessionState,
	sessionPaths,
	writeSessionState,
} from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

class FakeTransport implements HarnessSessionTransport {
	cursor = 0;
	state: SessionStateSnapshot = { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	ack = true;
	accept = true;
	agentStarts: number[] = [];
	closeError: Error | null = null;
	closeCalls = 0;
	closeImpl: ((call: number, context: HarnessSessionTransportCloseContext) => Promise<void>) | null = null;
	unsubscribeImpl: (() => void) | null = null;
	async getState(): Promise<SessionStateSnapshot> {
		return this.state;
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		if (this.accept) {
			this.cursor += 1;
			this.agentStarts.push(this.cursor);
		}
		return { commandId: "cmd-1", ack: this.ack };
	}
	async waitForAgentStart(afterCursor: number): Promise<{ cursor: number } | null> {
		const found = this.agentStarts.find(c => c > afterCursor);
		return found === undefined ? null : { cursor: found };
	}
	onEventFrame(_listener: (frame: Record<string, unknown>) => void): () => void {
		return () => this.unsubscribeImpl?.();
	}
	async close(context?: HarnessSessionTransportCloseContext): Promise<void> {
		this.closeCalls += 1;
		if (this.closeImpl) {
			if (!context) throw new Error("Test transport close context is required.");
			await this.closeImpl(this.closeCalls, context);
		}
		if (this.closeError) throw this.closeError;
	}
}

let root: string;
const SID = "o";
let owner: RuntimeOwner | null = null;

function seedState(workspace: string): SessionState {
	const now = new Date().toISOString();
	const handle = { sessionId: SID, harness: "gajae-code", workspace, branch: "feat/x" } as SessionHandle;
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "started",
		harness: "gajae-code",
		handle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	// Short root keeps the AF_UNIX socket path under the sun_path limit.
	root = await mkdtemp(path.join(tmpdir(), "h"));
	await writeSessionState(root, seedState(root));
	owner = null;
});

afterEach(async () => {
	await owner?.stop();
	await rm(root, { recursive: true, force: true });
});

describe("RuntimeOwner (in-process integration)", () => {
	it("routes submit through the endpoint, accepts via single-flight, and is the single event writer", async () => {
		const transport = new FakeTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		const info = await owner.start();
		expect(info.leaseEpoch).toBe(1);

		const live = await resolveOwner(root, SID);
		expect(live.live).toBe(true);
		expect(live.socketPath).toBe(info.socketPath);

		const res = (await callEndpoint(info.socketPath, { verb: "submit", input: { prompt: "do it" } })) as Record<
			string,
			unknown
		>;
		expect(res.ok).toBe(true);
		expect((res.evidence as Record<string, unknown>).accepted).toBe(true);
		expect((res.state as Record<string, unknown>).lifecycle).toBe("observing");
		expect((res.state as Record<string, unknown>).ownerLive).toBe(true);

		const events = await readEvents(root, SID, 0);
		const kinds = events.map(e => e.kind);
		expect(kinds).toContain("owner_started");
		expect(kinds).toContain("prompt_accepted");
		// Single writer: every event is stamped with this owner + lease epoch, cursors strictly increasing.
		for (const e of events) {
			expect(e.writer.ownerId).toBe(info.ownerId);
			expect(e.writer.leaseEpoch).toBe(1);
		}
		expect(events.map(e => e.cursor)).toEqual([...events.map(e => e.cursor)].sort((a, b) => a - b));
	});

	it("routes operate through the owner lease-guarded event writer", async () => {
		const transport = new FakeTransport();
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 100,
			finalizeChecks: {
				async runValidation(spec) {
					return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
				},
				async resolveCommit() {
					return "abc123";
				},
				async commitOnBranch() {
					return true;
				},
				async prOrIssue() {
					return { prUrl: "https://example.invalid/pr/1", issueArtifact: null };
				},
			},
			validationCommands: [{ name: "test", command: "bun test" }],
		});
		const info = await owner.start();
		await writeSessionState(root, { ...seedState(root), lifecycle: "finalizing" });

		const res = (await callEndpoint(info.socketPath, {
			verb: "operate",
			input: { goal: "finish", maxIterations: 1 },
		})) as Record<string, unknown>;

		expect(res.ok).toBe(true);
		expect(((res.evidence as Record<string, unknown>).operate as Record<string, unknown>).completed).toBe(true);
		const events = await readEvents(root, SID, 0);
		expect(events.map(e => e.kind)).toContain("operate_started");
		expect(events.map(e => e.kind)).toContain("operate_finalized");
		const finalized = events.find(e => e.kind === "operate_finalized");
		expect(finalized?.state.lifecycle).toBe("completed");
		expect(finalized?.nextAllowedActions.some(action => action.verb === "observe" && action.available)).toBe(true);
		expect(events.every(e => e.writer.ownerId === info.ownerId)).toBe(true);
		expect(events.every(e => e.writer.leaseEpoch === info.leaseEpoch)).toBe(true);
	});

	it("blocks submit when the harness acks but never starts (no false-positive acceptance)", async () => {
		const transport = new FakeTransport();
		transport.accept = false; // ack only, no agent_start
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 100 });
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "submit", input: { prompt: "p" } })) as Record<
			string,
			unknown
		>;
		expect(res.ok).toBe(false);
		expect((res.evidence as Record<string, unknown>).accepted).toBe(false);
		expect((res.evidence as Record<string, unknown>).reason).toBe("no-agent-start-within-timeout");
		const events = await readEvents(root, SID, 0);
		expect(events.map(e => e.kind)).toContain("prompt_not_accepted");
		const warn = events.find(e => e.kind === "prompt_not_accepted");
		expect(warn?.severity).toBe("warn");
	});

	it("blocks submit during finalizing and does not call RPC", async () => {
		const transport = new FakeTransport();
		await writeSessionState(root, { ...seedState(root), lifecycle: "finalizing" });
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 100 });
		const info = await owner.start();

		const res = (await callEndpoint(info.socketPath, { verb: "submit", input: { prompt: "too soon" } })) as Record<
			string,
			unknown
		>;

		expect(res.ok).toBe(false);
		expect((res.evidence as Record<string, unknown>).accepted).toBe(false);
		expect((res.evidence as Record<string, unknown>).submitted).toBe(false);
		expect((res.evidence as Record<string, unknown>).reason).toBe("lifecycle-not-idle:finalizing");
		expect(res.nextAllowedActions).toContainEqual({
			verb: "submit",
			available: false,
			reason: "lifecycle-not-idle:finalizing",
		});
		expect(transport.cursor).toBe(0);
	});

	it("reports rpc-not-idle as not submitted and stops advertising submit", async () => {
		const transport = new FakeTransport();
		transport.state = { isStreaming: true, steeringQueueDepth: 0, followupQueueDepth: 0 };
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 100 });
		const info = await owner.start();

		const res = (await callEndpoint(info.socketPath, { verb: "submit", input: { prompt: "too soon" } })) as Record<
			string,
			unknown
		>;

		expect(res.ok).toBe(false);
		expect((res.evidence as Record<string, unknown>).accepted).toBe(false);
		expect((res.evidence as Record<string, unknown>).submitted).toBe(false);
		expect((res.evidence as Record<string, unknown>).reason).toBe("pre-state-not-idle");
		expect(res.nextAllowedActions).toContainEqual({ verb: "submit", available: false, reason: "rpc-not-idle" });
		expect(transport.cursor).toBe(0);
	});

	it("live owner reconcile preserves vanished blockers until recovery evidence", async () => {
		const transport = new FakeTransport();
		await writeSessionState(root, {
			...seedState(root),
			lifecycle: "blocked",
			blockers: ["owner-vanished:dirty"],
		});
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		const info = await owner.start();

		const obs = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;

		expect((obs.state as Record<string, unknown>).ownerLive).toBe(true);
		expect((obs.state as Record<string, unknown>).lifecycle).toBe("blocked");
		expect((obs.state as Record<string, unknown>).blockers).toContain("owner-vanished:dirty");
		expect(obs.nextAllowedActions).toContainEqual({ verb: "submit", available: false, reason: "lifecycle-blocked" });
		const persisted = await readSessionState(root, SID);
		expect(persisted?.lifecycle).toBe("blocked");
		expect(persisted?.blockers).toContain("owner-vanished:dirty");
	});

	it("recover clears vanished blockers after writing vanish receipt evidence", async () => {
		const transport = new FakeTransport();
		const init = Bun.spawnSync(["git", "init"], { cwd: root, stdout: "pipe", stderr: "pipe" });
		expect(init.exitCode).toBe(0);
		await writeSessionState(root, {
			...seedState(root),
			lifecycle: "blocked",
			blockers: ["owner-vanished:dirty"],
		});
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		const info = await owner.start();

		const res = (await callEndpoint(info.socketPath, { verb: "recover", input: {} })) as Record<string, unknown>;
		const evidence = res.evidence as Record<string, unknown>;

		expect(typeof evidence.vanishReceiptId).toBe("string");
		expect((evidence.decision as Record<string, unknown>)?.classification).toBe("restart-preserve-delta");
		expect((res.state as Record<string, unknown>).lifecycle).toBe("observing");
		expect((res.state as Record<string, unknown>).blockers).not.toContain("owner-vanished:dirty");
		expect(await readReceiptIndex(root, SID, "vanish")).toHaveLength(1);
		const persisted = await readSessionState(root, SID);
		expect(persisted?.lifecycle).toBe("observing");
		expect(persisted?.blockers).not.toContain("owner-vanished:dirty");
	});

	it("live owner reconcile clears detached startup false-negative blockers", async () => {
		const transport = new FakeTransport();
		await writeSessionState(root, {
			...seedState(root),
			lifecycle: "blocked",
			blockers: ["detached-owner-not-live"],
		});
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		const info = await owner.start();

		const obs = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;

		expect((obs.state as Record<string, unknown>).ownerLive).toBe(true);
		expect((obs.state as Record<string, unknown>).lifecycle).toBe("observing");
		expect((obs.state as Record<string, unknown>).blockers).not.toContain("detached-owner-not-live");
		expect(obs.nextAllowedActions).toContainEqual({ verb: "submit", available: true });
		const persisted = await readSessionState(root, SID);
		expect(persisted?.lifecycle).toBe("observing");
		expect(persisted?.blockers).not.toContain("detached-owner-not-live");
	});

	it("observe is owner-routed and reports ownerLive; retire releases the lease", async () => {
		const transport = new FakeTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		const info = await owner.start();

		const obs = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<string, unknown>;
		expect((obs.evidence as Record<string, unknown>).ownerRouted).toBe(true);
		expect((obs.state as Record<string, unknown>).ownerLive).toBe(true);

		const ret = (await callEndpoint(info.socketPath, { verb: "retire", input: {} })) as Record<string, unknown>;
		expect((ret.evidence as Record<string, unknown>).retired).toBe(true);

		// Poll for the owner to release the lease + close the endpoint (robust under load).
		let after = await resolveOwner(root, SID);
		for (let i = 0; i < 100 && after.live; i++) {
			await new Promise(r => setTimeout(r, 20));
			after = await resolveOwner(root, SID);
		}
		expect(after.live).toBe(false);
	});
	it("records transport stop failure and retains the owner lease (fail closed)", async () => {
		const transport = new FakeTransport();
		transport.closeError = new Error("child did not exit after SIGKILL");
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 200,
			cleanupRetryLimit: 1,
		});
		await owner.start();

		await expect(owner.stop()).rejects.toThrow("Runtime owner cleanup could not be verified");
		owner = null;

		const events = await readEvents(root, SID, 0);
		const failure = events.find(event => event.kind === "owner_transport_stop_failed");
		expect(failure?.severity).toBe("critical");
		expect(failure?.evidence.error).toContain("child did not exit after SIGKILL");
		// Fail closed: an unverified transport teardown must NOT surrender authority. The spawned
		// child the transport owns may still be live, so the lease stays held — no interval exists
		// where an unverified live transport has released the lease.
		expect((await resolveOwner(root, SID)).live).toBe(true);
	});

	it("keeps live authority while retrying unverified transport teardown", async () => {
		const transport = new FakeTransport();
		transport.closeError = new Error("exact child is still live");
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 200,
			cleanupRetryMs: 100,
		});
		const info = await owner.start();

		let settled = false;
		const stopping = owner.stop().finally(() => {
			settled = true;
		});
		while (transport.closeCalls === 0) await Bun.sleep(0);

		expect(settled).toBe(false);
		expect((await resolveOwner(root, SID)).live).toBe(true);
		const observation = (await callEndpoint(info.socketPath, { verb: "observe", input: {} })) as Record<
			string,
			unknown
		>;
		expect(observation.ok).toBe(true);

		transport.closeError = null;
		await stopping;
		expect(transport.closeCalls).toBeGreaterThanOrEqual(2);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		owner = null;
	});

	it("serializes simultaneous stop calls through one cleanup result", async () => {
		const transport = new FakeTransport();
		const closeStarted = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		transport.closeImpl = async () => {
			closeStarted.resolve();
			await releaseClose.promise;
		};
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		await owner.start();

		const first = owner.stop();
		const second = owner.stop();
		expect(second).toBe(first);
		await closeStarted.promise;
		expect(transport.closeCalls).toBe(1);

		releaseClose.resolve();
		await Promise.all([first, second]);
		expect(owner.stop()).toBe(first);
		expect(transport.closeCalls).toBe(1);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		owner = null;
	});

	it("allows transport cleanup to await a reentrant stop without deadlocking", async () => {
		const transport = new FakeTransport();
		let reentrantCompleted = false;
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		transport.closeImpl = async (_call, context) => {
			await context.acknowledgeDirectOwnerStopReentry();
			reentrantCompleted = true;
		};
		await owner.start();

		const outcome = await Promise.race([owner.stop().then(() => "stopped"), Bun.sleep(250).then(() => "timeout")]);

		expect(outcome).toBe("stopped");
		expect(reentrantCompleted).toBe(true);
		expect(transport.closeCalls).toBe(1);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		owner = null;
	});

	it("does not grant a synchronous foreign caller the direct close capability", async () => {
		const transport = new FakeTransport();
		const closeEntered = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		const foreignDone = Promise.withResolvers<void>();
		let directResolved = false;
		let foreignResolved = false;
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		transport.closeImpl = (_call, context) => {
			const foreignCallback = (): void => {
				void owner?.stop().then(() => {
					foreignResolved = true;
					foreignDone.resolve();
				});
			};
			foreignCallback();
			const direct = context.acknowledgeDirectOwnerStopReentry().then(() => {
				directResolved = true;
			});
			return (async () => {
				await direct;
				closeEntered.resolve();
				await releaseClose.promise;
			})();
		};
		await owner.start();

		const outer = owner.stop();
		await closeEntered.promise;
		await Bun.sleep(0);
		expect(directResolved).toBe(true);
		expect(foreignResolved).toBe(false);

		releaseClose.resolve();
		await outer;
		await foreignDone.promise;
		expect(foreignResolved).toBe(true);
		expect(transport.closeCalls).toBe(1);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		owner = null;
	});

	it("expires an unused direct close capability before descendant work runs", async () => {
		const transport = new FakeTransport();
		const closeEntered = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		let captured: HarnessSessionTransportCloseContext | null = null;
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		transport.closeImpl = async (_call, context) => {
			captured = context;
			closeEntered.resolve();
			await releaseClose.promise;
		};
		await owner.start();

		const outer = owner.stop();
		await closeEntered.promise;
		expect(() => captured?.acknowledgeDirectOwnerStopReentry()).toThrow(
			"Runtime owner direct stop reentry capability is no longer available.",
		);

		releaseClose.resolve();
		await outer;
		expect(transport.closeCalls).toBe(1);
		owner = null;
	});
	it("does not grant descendant cleanup tasks early stop completion", async () => {
		const transport = new FakeTransport();
		const releaseClose = Promise.withResolvers<void>();
		const descendantDone = Promise.withResolvers<void>();
		let descendantResolved = false;
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		transport.closeImpl = async () => {
			queueMicrotask(() => {
				void owner?.stop().then(() => {
					descendantResolved = true;
					descendantDone.resolve();
				});
			});
			await releaseClose.promise;
		};
		await owner.start();

		const outer = owner.stop();
		while (transport.closeCalls === 0) await Bun.sleep(0);
		await Bun.sleep(0);
		expect(descendantResolved).toBe(false);

		releaseClose.resolve();
		await outer;
		await descendantDone.promise;
		expect(descendantResolved).toBe(true);
		expect(transport.closeCalls).toBe(1);
		owner = null;
	});

	it("publishes the stop result before synchronous unsubscribe reentrancy", async () => {
		const transport = new FakeTransport();
		let reentrantCalls = 0;
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		transport.unsubscribeImpl = () => {
			reentrantCalls += 1;
			void owner?.stop();
		};
		await owner.start();

		await owner.stop();

		expect(reentrantCalls).toBe(1);
		expect(transport.closeCalls).toBe(1);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		owner = null;
	});

	it("keeps simultaneous callers pending until a failed cleanup retry succeeds", async () => {
		const transport = new FakeTransport();
		const firstFailed = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		transport.closeImpl = async call => {
			if (call <= 2) {
				if (call === 1) firstFailed.resolve();
				throw new Error("cleanup could not verify child exit");
			}
			await releaseRetry.promise;
		};
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 200,
			cleanupRetryMs: 0,
			cleanupRetryLimit: 3,
		});
		await owner.start();

		let settled = false;
		const first = owner.stop().finally(() => {
			settled = true;
		});
		const simultaneous = owner.stop();
		await firstFailed.promise;
		while (transport.closeCalls < 3) await Bun.sleep(0);

		expect(settled).toBe(false);
		expect((await resolveOwner(root, SID)).live).toBe(true);
		releaseRetry.resolve();
		await Promise.all([first, simultaneous]);

		expect(transport.closeCalls).toBe(3);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		const failures = (await readEvents(root, SID, 0)).filter(event => event.kind === "owner_transport_stop_failed");
		expect(failures).toHaveLength(1);
		owner = null;
	});

	it("retains the lease when control-server cleanup cannot be verified", async () => {
		const transport = new FakeTransport();
		const serverError = new Error("control endpoint cleanup failed");
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 200,
			cleanupRetryLimit: 1,
			controlServerFactory(socketPath, handler) {
				const server = new ControlServer(socketPath, handler);
				const close = server.close.bind(server);
				server.close = async () => {
					await close();
					throw serverError;
				};
				return server;
			},
		});
		const info = await owner.start();

		await expect(owner.stop()).rejects.toThrow("Runtime owner cleanup could not be verified");

		expect(transport.closeCalls).toBe(1);
		const retained = await resolveOwner(root, SID);
		expect(retained.live).toBe(true);
		expect(retained.lease?.ownerId).toBe(info.ownerId);
		const failures = (await readEvents(root, SID, 0)).filter(event => event.kind === "owner_server_stop_failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.evidence.error).toContain(serverError.message);
		const replacement = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport(),
			acceptanceTimeoutMs: 200,
		});
		await expect(replacement.start()).rejects.toThrow(/lease_held/);
		owner = null;
	});

	it("blocks replacement owner takeover while transport cleanup is unverified", async () => {
		const transport = new FakeTransport();
		transport.closeError = new Error("child did not exit after SIGKILL");
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 200,
			cleanupRetryLimit: 1,
		});
		const priorOwnerInfo = await owner.start();

		// stop() fails closed: transport teardown is unverified, so authority is retained.
		await expect(owner.stop()).rejects.toThrow("Runtime owner cleanup could not be verified");
		owner = null;

		// Authority/lease is still held by the original owner.
		const retained = await resolveOwner(root, SID);
		expect(retained.live).toBe(true);
		expect(retained.lease?.ownerId).toBe(priorOwnerInfo.ownerId);

		// A replacement owner cannot mint authority while the original lease is still held —
		// takeover is refused rather than minting overlapping control of the live child.
		const replacementTransport = new FakeTransport();
		const replacement = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: replacementTransport,
			acceptanceTimeoutMs: 200,
		});
		await expect(replacement.start()).rejects.toThrow(/lease_held/);
		expect(replacementTransport.closeCalls).toBe(1);
		// No new live owner was minted: the original still holds the lease.
		const afterReplacement = await resolveOwner(root, SID);
		expect(afterReplacement.live).toBe(true);
		expect(afterReplacement.lease?.ownerId).toBe(priorOwnerInfo.ownerId);
	});
	it("rolls back exact transport ownership when startup fails", async () => {
		const transport = new FakeTransport();
		const startError = new Error("control endpoint listen failed");
		const cleanupError = new Error("first rollback could not verify child exit");
		const releaseRollback = Promise.withResolvers<void>();
		transport.closeImpl = async call => {
			if (call === 1) throw cleanupError;
			await releaseRollback.promise;
		};
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			acceptanceTimeoutMs: 200,
			ttlMs: 10,
			heartbeatMs: 2,
			cleanupRetryMs: 0,
			cleanupRetryLimit: 2,
			controlServerFactory(socketPath, handler) {
				const server = new ControlServer(socketPath, handler);
				server.listen = async () => {
					throw startError;
				};
				return server;
			},
		});

		const start = owner.start();
		while (transport.closeCalls < 2) await Bun.sleep(0);
		const initialLease = await readLease(root, SID);
		await Bun.sleep(30);
		const renewedLease = await readLease(root, SID);
		const liveDuringRollback = (await resolveOwner(root, SID)).live;
		releaseRollback.resolve();
		const error = await start.then(
			() => undefined,
			failure => failure,
		);

		expect(initialLease).not.toBeNull();
		expect(renewedLease).not.toBeNull();
		expect(Date.parse(renewedLease!.heartbeatAt)).toBeGreaterThan(Date.parse(initialLease!.heartbeatAt));
		expect(liveDuringRollback).toBe(true);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors[0]).toBe(startError);
		expect((error as AggregateError).errors[1]).toBe(cleanupError);
		expect(transport.closeCalls).toBe(2);
		expect((await resolveOwner(root, SID)).live).toBe(false);
		owner = null;
	});

	it("fences the lease heartbeat before releasing so release cannot contend with a renewal", async () => {
		// Regression for the lease_lock_timeout flake: an aggressive heartbeat
		// (renewing every 2ms) must be stopped/joined/fenced before releaseLease
		// acquires the lease mutation lock, or the two contend and the release
		// starves. We prove the fence by observing the persisted lease: once release
		// begins, no renewal advances heartbeatAt across a window spanning many
		// heartbeat intervals.
		const transport = new FakeTransport();
		let heartbeatAtRelease: string | undefined;
		let heartbeatAfterWindow: string | undefined;
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			heartbeatMs: 2,
			ttlMs: 10_000,
			leaseRelease: async (releaseRoot, releaseSession, releaseOwnerId) => {
				heartbeatAtRelease = (await readLease(releaseRoot, releaseSession))?.heartbeatAt;
				// Detection window: a live 2ms heartbeat would renew ~20 times here.
				await new Promise(resolve => setTimeout(resolve, 40));
				heartbeatAfterWindow = (await readLease(releaseRoot, releaseSession))?.heartbeatAt;
				return releaseLease(releaseRoot, releaseSession, releaseOwnerId);
			},
		});
		await owner.start();
		await owner.stop();
		owner = null;

		expect(heartbeatAtRelease).toBeDefined();
		// Deterministic: the fenced heartbeat performed zero renewals during release.
		expect(heartbeatAfterWindow).toBe(heartbeatAtRelease);
		expect((await resolveOwner(root, SID)).live).toBe(false);
	});

	it("drains an older in-flight heartbeat even after a newer renewal has already settled", async () => {
		// Deterministic kill-test for the single-slot regression. An OLDER renewal
		// (#1) is held in flight while NEWER renewals settle, so the "latest promise"
		// slot points at a settled renewal, not #1. A complete Set drain must still
		// await #1 before releaseLease; a single-slot join (awaiting only the latest,
		// already-settled renewal) would release while #1 is still in flight, which
		// this test detects. The heartbeat seam never re-enters the real lock path
		// (it only reads the lease), so ticks cannot slow or perturb the ordering.
		const transport = new FakeTransport();
		const olderEntered = Promise.withResolvers<void>();
		const newerSettled = Promise.withResolvers<void>();
		const olderGate = Promise.withResolvers<void>();
		let olderActive = false;
		let releaseEnteredWhileOlderActive = false;
		let newerSignalled = false;
		let calls = 0;
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			heartbeatMs: 1,
			ttlMs: 10_000,
			leaseHeartbeat: async (hbRoot, hbSession) => {
				const n = ++calls;
				// Non-mutating read: never contends the lease mutation lock, so the
				// only in-flight renewal that stays pending is the intentionally gated
				// older one.
				const lease = (await readLease(hbRoot, hbSession))!;
				if (n === 1) {
					olderActive = true;
					olderEntered.resolve();
					await olderGate.promise;
					olderActive = false;
					return lease;
				}
				// Newer renewals settle immediately, becoming the latest tracked slot.
				if (!newerSignalled) {
					newerSignalled = true;
					newerSettled.resolve();
				}
				return lease;
			},
			leaseRelease: async (relRoot, relSession, relOwner) => {
				if (olderActive) releaseEnteredWhileOlderActive = true;
				return releaseLease(relRoot, relSession, relOwner);
			},
		});
		await owner.start();
		await olderEntered.promise; // older (#1) renewal is in flight and gated
		await newerSettled.promise; // a newer renewal has fully settled (latest slot cleared)

		const stopPromise = owner.stop();
		// A complete drain must still await the gated older renewal; a single-slot
		// join (awaiting only the settled latest) would release now. Detection window
		// gives a reverted implementation time to wrongly release.
		await new Promise(resolve => setTimeout(resolve, 25));
		expect(releaseEnteredWhileOlderActive).toBe(false);

		olderGate.resolve(); // only now may the drain complete and release proceed
		await stopPromise;
		owner = null;

		expect(releaseEnteredWhileOlderActive).toBe(false);
		expect((await resolveOwner(root, SID)).live).toBe(false);
	});

	it("a fenced owner never releases a successor's lease", async () => {
		const transport = new FakeTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport, heartbeatMs: 2, ttlMs: 10_000 });
		const first = await owner.start();

		// A successor legitimately takes over the lease before the original tears down.
		await releaseLease(root, SID, first.ownerId);
		const { lease: successor } = await acquireLease(root, SID, {
			ownerId: "successor-owner",
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: `${controlSocketPath(root, SID)}.successor` },
			eventsPath: sessionPaths(root, SID).events,
			ttlMs: 30_000,
		});

		// Original owner shuts down; fencing must not renew nor release the successor.
		await owner.stop();
		owner = null;

		const after = await readLease(root, SID);
		expect(after?.ownerId).toBe("successor-owner");
		expect(after?.leaseEpoch).toBe(successor.leaseEpoch);
	});
	it("releases the owner lease after successful transport cleanup and allows replacement takeover", async () => {
		const transport = new FakeTransport();
		owner = new RuntimeOwner({ root, sessionId: SID, transport, acceptanceTimeoutMs: 200 });
		const priorOwnerInfo = await owner.start();

		await owner.stop();
		owner = null;

		// Verified teardown surrenders authority cleanly — no lease remains.
		expect((await resolveOwner(root, SID)).live).toBe(false);

		// A replacement owner can mint authority once the original released the lease.
		const replacement = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport(),
			acceptanceTimeoutMs: 200,
		});
		owner = replacement;
		const takeover = await replacement.start();
		expect(takeover.ownerId).not.toBe(priorOwnerInfo.ownerId);
		const after = await resolveOwner(root, SID);
		expect(after.live).toBe(true);
		expect(after.lease?.ownerId).toBe(takeover.ownerId);
	});
	it("settles shutdown after a successor replaces its lease", async () => {
		const transport = new FakeTransport();
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport,
			heartbeatMs: 60_000,
		});
		const first = await owner.start();
		await releaseLease(root, SID, first.ownerId);
		const { lease: successor } = await acquireLease(root, SID, {
			ownerId: "successor-owner",
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: `${controlSocketPath(root, SID)}.successor` },
			eventsPath: sessionPaths(root, SID).events,
			ttlMs: 30_000,
		});

		await owner.stop();

		expect(transport.closeCalls).toBe(1);
		expect(successor.ownerId).not.toBe(first.ownerId);
		expect((await readLease(root, SID))?.ownerId).toBe(successor.ownerId);
		owner = null;
	});
});

describe("resolveOwnerLive (lease/socket liveness probe)", () => {
	it("returns false when no lease exists (owner never started)", async () => {
		expect(await resolveOwnerLive(root, SID)).toBe(false);
	});

	it("returns true for a live lease with a socket endpoint (live manual owner)", async () => {
		await acquireLease(root, SID, {
			ownerId: "manual-owner",
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
			eventsPath: sessionPaths(root, SID).events,
			ttlMs: 30_000,
		});
		expect(await resolveOwnerLive(root, SID)).toBe(true);
	});

	it("returns false for a live lease without a routable endpoint", async () => {
		await acquireLease(root, SID, {
			ownerId: "endpointless-owner",
			pid: process.pid,
			eventsPath: sessionPaths(root, SID).events,
			ttlMs: 30_000,
		});
		expect(await resolveOwnerLive(root, SID)).toBe(false);
	});
});
