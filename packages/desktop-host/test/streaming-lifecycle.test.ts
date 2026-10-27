/**
 * Streaming, steering and abort lifecycle of the desktop host, driven in-process
 * through its documented `createSession` seam so the orchestration can be
 * verified without a live provider call.
 *
 * The fake session reproduces the SDK's observable contract: it reports
 * `isStreaming` while a turn runs, emits `message_update` events, settles queued
 * submissions with a disposition, and cancels a submission only while it is
 * still queued.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { DesktopHost } from "../src/host";
import type {
	DesktopCommandResult,
	DesktopFrame,
	DesktopProject,
	DesktopRequest,
	DesktopSession,
	DesktopSnapshot,
} from "../src/protocol";

interface PendingPrompt {
	text: string;
	settle: () => void;
}

interface FakeSession {
	session: AgentSession;
	streaming: () => boolean;
	prompted: string[];
	steers: string[];
	aborts: number;
	finishTurn: () => void;
}

function fakeSession(projectPath: string, dataDir: string, sessionId: string): FakeSession {
	const listeners = new Set<(event: unknown) => void>();
	const messages: unknown[] = [];
	const prompted: string[] = [];
	const steers: string[] = [];
	let streaming = false;
	let aborts = 0;
	let pending: PendingPrompt | undefined;
	const transcript = path.join(dataDir, "sessions", "fake", `${sessionId}.jsonl`);

	const emit = (event: unknown) => {
		for (const listener of listeners) listener(event);
	};
	const finishTurn = () => {
		streaming = false;
		pending?.settle();
		pending = undefined;
		emit({ type: "agent_end" });
	};

	const session = {
		get isStreaming() {
			return streaming;
		},
		get messages() {
			return messages;
		},
		get model() {
			return undefined;
		},
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string) {
			prompted.push(text);
			streaming = true;
			messages.push({ role: "user", content: text, timestamp: Date.now() });
			emit({ type: "message_update", message: { role: "assistant", content: "working", timestamp: Date.now() } });
			const deferred = Promise.withResolvers<void>();
			pending = { text, settle: deferred.resolve };
			await deferred.promise;
			messages.push({ role: "assistant", content: `echo: ${text}`, timestamp: Date.now() });
		},
		async abort() {
			aborts += 1;
			finishTurn();
		},
		async submitUserMessage(text: string, options: { deliverAs: string }) {
			steers.push(`${options.deliverAs}:${text}`);
			const execution = Promise.withResolvers<{ submissionId: string; disposition: "promoted-to-run" }>();
			const terminal = Promise.withResolvers<{ submissionId: string; disposition: "removed"; reason: string }>();
			const submissionId = `sub-${steers.length}`;
			let settled = false;
			return {
				submissionId,
				admitted: Promise.resolve({ submissionId, disposition: "admitted" }),
				execution: execution.promise,
				terminal: terminal.promise,
				cancel: () => {
					if (settled) return false;
					settled = true;
					terminal.resolve({ submissionId, disposition: "removed", reason: "user" });
					return true;
				},
			};
		},
		async setSessionName() {},
		getAllToolNames: () => ["read", "bash"],
		getActiveToolNames: () => ["read"],
		getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
		async setActiveToolsByName() {},
		async reloadSkills() {},
		async dispose() {
			listeners.clear();
		},
		sessionManager: {
			getCwd: () => projectPath,
			getSessionName: () => "New session",
			getSessionFile: () => transcript,
			async ensureOnDisk() {
				await fs.mkdir(path.dirname(transcript), { recursive: true });
				await Bun.write(transcript, "");
			},
			async flush() {
				await Bun.write(transcript, `${JSON.stringify({ role: "user" })}\n`);
			},
		},
	} as unknown as AgentSession;

	return {
		session,
		streaming: () => streaming,
		prompted,
		steers,
		get aborts() {
			return aborts;
		},
		finishTurn,
	};
}

describe("desktop streaming lifecycle", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function launch() {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-stream-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-project-"));
		const frames: DesktopFrame[] = [];
		const fakes: FakeSession[] = [];
		const host = new DesktopHost({
			dataDir,
			emit: (frame: DesktopFrame) => frames.push(frame),
			createSession: async options => {
				// Use the host's own resolved data dir: another suite may rewrite TMPDIR, and a
				// symlinked path would fail the transcript containment check.
				const fake = fakeSession(String(options.cwd), host.dataDir, crypto.randomUUID());
				fakes.push(fake);
				return { session: fake.session, setToolUIContext: () => {} } as never;
			},
		});
		cleanups.push(async () => {
			await host.close();
			await fs.rm(dataDir, { recursive: true, force: true });
			await fs.rm(projectDir, { recursive: true, force: true });
		});
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}) => {
			const id = crypto.randomUUID();
			const before = frames.length;
			await host.handle({ id, method, params } as DesktopRequest);
			const response = frames.slice(before).find(frame => frame.type === "response" && frame.id === id) as
				| { type: "response"; ok: true; result: T }
				| { type: "response"; ok: false; error: string }
				| undefined;
			if (!response) throw new Error(`No response for ${method}`);
			if (!response.ok) throw new Error(response.error);
			return response.result;
		};
		const snapshot = () => call<DesktopSnapshot>("bootstrap");
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		return { host, call, snapshot, project, session, fakes };
	}

	test("a run reports running, accepts a steer, and abort clears it", async () => {
		const { call, snapshot, session, fakes } = await launch();
		const fake = fakes[0]!;
		expect(session.status).toBe("idle");
		expect(fake.prompted).toEqual([]);

		// Start a turn without awaiting it: the RPC settles only when the run ends.
		const running = call("prompt", { sessionId: session.id, text: "긴 작업" });
		await Bun.sleep(30);
		expect(fake.streaming()).toBe(true);
		expect((await snapshot()).sessions[0]?.status).toBe("running");

		// A command cannot run while the turn holds the session lock.
		await expect(call("command.run", { sessionId: session.id, text: "/tools" })).rejects.toThrow("실행 중");

		// Steering is admitted with a cancelable chip.
		expect(
			await call<{ queued: boolean; submissionId: string }>("prompt", {
				sessionId: session.id,
				text: "방향 전환",
				deliverAs: "steer",
			}),
		).toEqual({
			queued: true,
			submissionId: "sub-1",
		});
		expect(fake.steers).toEqual(["steer:방향 전환"]);
		const queued = (await snapshot()).sessions[0]?.queued ?? [];
		expect(queued).toHaveLength(1);
		expect(queued[0]?.cancelable).toBe(true);

		// Cancelling settles and removes the chip.
		expect(await call<{ removed: boolean }>("queue.cancel", { sessionId: session.id, queueId: "sub-1" })).toEqual({
			removed: true,
		});
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(0);

		// Abort ends the run and drops anything still queued.
		await call("prompt", { sessionId: session.id, text: "두번째", deliverAs: "followUp" });
		expect((await snapshot()).sessions[0]?.queued ?? []).toHaveLength(1);
		await call("abort", { sessionId: session.id });
		expect(fake.aborts).toBe(1);
		// Abort ends the run, which releases the lock the pending prompt RPC holds.
		await running;
		const aborted = (await snapshot()).sessions[0];
		expect(aborted?.status).not.toBe("running");
		expect(aborted?.queued ?? []).toHaveLength(0);
	});

	test("a completed turn returns the session to idle and keeps its transcript", async () => {
		const { call, snapshot, session, fakes, project } = await launch();
		const fake = fakes[0]!;
		const running = call("prompt", { sessionId: session.id, text: "짧은 작업" });
		await Bun.sleep(30);
		fake.finishTurn();
		await running;

		const done = (await snapshot()).sessions[0];
		expect(done?.status).toBe("idle");
		expect(done?.messages.map(message => message.text)).toContain("echo: 짧은 작업");
		expect(await call<DesktopCommandResult>("command.run", { sessionId: session.id, text: "/jobs" })).toMatchObject({
			consumed: true,
		});
		expect(project.path).toBeTruthy();
	});
});
