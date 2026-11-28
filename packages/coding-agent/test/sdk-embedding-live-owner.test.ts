import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { registerDirectSession } from "../src/main";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { resolveSessionLocator, SessionIndex } from "../src/sdk/broker/session-index";
import { closeEmbeddedIdleOwner, createEmbeddedAgentSession, findEmbeddedLiveOwner } from "../src/sdk/embedding";
import { AgentDirSessionLifecycleService } from "../src/sdk/lifecycle/client";
import type { SessionLifecycleClient } from "../src/sdk/lifecycle/service";
import { SessionManager } from "../src/session/session-manager";
import {
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const cleanups: Array<() => Promise<void>> = [];
const brokerRoots: FixtureRootCleanup[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	await cleanupFixtureRoots(brokerRoots);
});

async function agentDir() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-owner-")));
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

const sessionId = "0b0f8a52-6a8f-4a59-9d1c-1f3c2d4e5f60";
/** A broker answer for one exact session.list request. */
function broker(sessions: Array<{ sessionId: string; live?: boolean }>, seen: unknown[] = []): SessionLifecycleClient {
	return {
		global: async (operation, input) => {
			seen.push({ operation, input });
			return { ok: true, result: { indexSeq: 1, sessions, warnings: [] } };
		},
	};
}

test("with no broker and no session index it answers none at once, and creates neither", async () => {
	const dir = await agentDir();
	const started = Date.now();
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId })).toEqual({ kind: "none" });
	expect(Date.now() - started).toBeLessThan(500);
	expect(await Bun.file(path.join(dir, "sdk", "broker.json")).exists()).toBe(false);
	expect(await fs.readdir(dir)).toEqual([]);
});

test("reports a live owner only for the exact session the broker lists as live", async () => {
	const dir = await agentDir();
	const seen: unknown[] = [];
	expect(
		await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: broker([{ sessionId, live: true }], seen) }),
	).toEqual({ kind: "live" });
	// One exact lookup: no workspace scan, no saved-session recap.
	expect(seen).toEqual([{ operation: "session.list", input: { resolveSessionId: sessionId } }]);
	expect(
		await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: broker([{ sessionId, live: false }]) }),
	).toEqual({ kind: "none" });
	expect(
		await findEmbeddedLiveOwner({
			agentDir: dir,
			sessionId,
			client: broker([{ sessionId: "1b0f8a52-6a8f-4a59-9d1c-1f3c2d4e5f60", live: true }]),
		}),
	).toEqual({ kind: "none" });
});

test("a broker that fails or does not answer in time is reported as unknown", async () => {
	const dir = await agentDir();
	const failing: SessionLifecycleClient = {
		global: async () => {
			throw new Error("connection refused");
		},
	};
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: failing })).toEqual({
		kind: "unknown",
		reason: "broker_unavailable",
	});
	const silent: SessionLifecycleClient = { global: () => Promise.withResolvers<unknown>().promise };
	const started = Date.now();
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: silent, timeoutMs: 50 })).toEqual({
		kind: "unknown",
		reason: "broker_unavailable",
	});
	expect(Date.now() - started).toBeLessThan(1000);
});

test.skipIf(process.platform === "win32")("the timeout also covers reading the broker's discovery file", async () => {
	const dir = await agentDir();
	const discovery = path.join(dir, "sdk", "broker.json");
	await fs.mkdir(path.dirname(discovery), { recursive: true });
	// A named pipe: reading it waits until a writer opens it, a discovery read that does not finish.
	await $`mkfifo ${discovery}`;
	cleanups.push(async () => {
		// Let the read still waiting on the pipe finish, so nothing stays blocked.
		await fs.writeFile(discovery, "{}");
	});
	const started = performance.now();
	const answer = await Promise.race([
		findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 100 }),
		Bun.sleep(2_000).then(() => "still waiting"),
	]);
	expect(answer).toEqual({ kind: "unknown", reason: "broker_unavailable" });
	expect(performance.now() - started).toBeLessThan(1_000);
});

test("a real broker accepts the exact lookup and answers none for a transcript nobody holds", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-owner-broker-")));
	const dir = path.join(root, "agent");
	const env = createFixtureBrokerEnvironment(root, dir);
	await Promise.all([dir, env.TMPDIR!, env.XDG_CONFIG_HOME!].map(item => fs.mkdir(item, { recursive: true })));
	const started = await withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir: dir, env }));
	brokerRoots.push(createFixtureRootCleanup(root, dir, started.lease));
	// `unknown` here would mean the broker refused the request shape, actor or target.
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "none" });
}, 60_000);

/** An agent directory and project for a real fixture broker; the broker is started on demand. */
async function brokerWorkspace() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-owner-live-")));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const dir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const env = createFixtureBrokerEnvironment(root, dir);
	await Promise.all([dir, cwd, env.TMPDIR!, env.XDG_CONFIG_HOME!].map(item => fs.mkdir(item, { recursive: true })));
	return {
		dir,
		cwd,
		startBroker: async () => {
			const started = await withFixtureBrokerEnvironment(() =>
				startFixtureBrokerWithLeaseForTest({ agentDir: dir, env }),
			);
			brokerRoots.push(createFixtureRootCleanup(root, dir, started.lease));
		},
	};
}

/** A transcript in the shared store, as the terminal and the app both create them. */
async function sharedTranscript(cwd: string, dir: string) {
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, dir));
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.flush();
	cleanups.push(() => manager.close().catch(() => {}));
	return manager;
}

test("a terminal session's registration is reported live by a real broker, and nothing without one", async () => {
	const { dir, cwd, startBroker } = await brokerWorkspace();
	const manager = await sharedTranscript(cwd, dir);
	const sessionId = manager.getSessionId();
	// What every CLI run with a durable transcript does at startup, whatever its mode or SDK hosting.
	// Its process-exit cleanup is not this test's to install.
	await registerDirectSession(manager, dir, undefined, { registerPostmortem: () => () => {} });
	// With no broker running, the registration in the session index and a probe of that exact
	// process (this test's own) report it.
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 5_000 })).toEqual({ kind: "live" });
	expect(await Bun.file(path.join(dir, "sdk", "broker.json")).exists()).toBe(false);
	await startBroker();
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "live" });
}, 60_000);

test("a transcript an embedding holds open is not reported live, so the embedding never steps aside for itself", async () => {
	const { dir, cwd, startBroker } = await brokerWorkspace();
	await startBroker();
	const manager = await sharedTranscript(cwd, dir);
	// The desktop app's own writer: an embedded session with SDK and notification hosting off.
	const embedded = await createEmbeddedAgentSession({
		cwd,
		agentDir: dir,
		storage: { managed: true, manager },
		hasUI: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
	});
	cleanups.push(async () => {
		await embedded.session.dispose();
		await embedded.releaseResources();
	});
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId: manager.getSessionId(), timeoutMs: 10_000 })).toEqual(
		{
			kind: "none",
		},
	);
}, 60_000);

test("an idle-only close with no broker running answers at once and starts nothing", async () => {
	const dir = await agentDir();
	const started = Date.now();
	expect(await closeEmbeddedIdleOwner({ agentDir: dir, sessionId })).toEqual({
		kind: "unknown",
		reason: "broker_absent",
	});
	expect(Date.now() - started).toBeLessThan(500);
	expect(await Bun.file(path.join(dir, "sdk", "broker.json")).exists()).toBe(false);
});

test("an idle-only close is one idle-fenced request, and reports the broker's own answer", async () => {
	const dir = await agentDir();
	const seen: Array<{ operation: string; input: Record<string, unknown>; key?: string }> = [];
	const answering = (answer: unknown): SessionLifecycleClient => ({
		global: async (operation, input, options) => {
			seen.push({ operation, input, key: options.idempotencyKey });
			return answer;
		},
	});
	expect(
		await closeEmbeddedIdleOwner({
			agentDir: dir,
			sessionId,
			client: answering({ ok: true, result: { sessionId } }),
		}),
	).toEqual({ kind: "closed" });
	// Never a plain close: the owner decides, and only when it has nothing in progress.
	expect(seen.map(({ operation, input }) => ({ operation, input }))).toEqual([
		{ operation: "session.close", input: { sessionId, ifIdle: true } },
	]);
	for (const code of ["busy", "close_refused", "not_found"])
		expect(
			await closeEmbeddedIdleOwner({
				agentDir: dir,
				sessionId,
				client: answering({ ok: false, error: { code, message: "refused" } }),
			}),
		).toEqual({ kind: "not_closed", code });
	// A retry after a refusal is a new request, never a replay of the refusal.
	expect(new Set(seen.map(request => request.key)).size).toBe(seen.length);
	expect(seen.every(request => typeof request.key === "string" && request.key.length > 0)).toBe(true);
});

test("an idle-only close that fails in transport or gets no answer in time is reported as unknown", async () => {
	const dir = await agentDir();
	const failing: SessionLifecycleClient = {
		global: async () => {
			throw new Error("connection refused");
		},
	};
	// A transport failure is no answer about the owner.
	expect(await closeEmbeddedIdleOwner({ agentDir: dir, sessionId, client: failing })).toEqual({
		kind: "unknown",
		reason: "broker_unavailable",
	});
	const silent: SessionLifecycleClient = { global: () => Promise.withResolvers<unknown>().promise };
	const started = Date.now();
	expect(await closeEmbeddedIdleOwner({ agentDir: dir, sessionId, client: silent, timeoutMs: 50 })).toEqual({
		kind: "unknown",
		reason: "broker_unavailable",
	});
	expect(Date.now() - started).toBeLessThan(1000);
});

test("a real broker refuses to idle-close a terminal's session, which stays live", async () => {
	const { dir, cwd, startBroker } = await brokerWorkspace();
	const manager = await sharedTranscript(cwd, dir);
	const sessionId = manager.getSessionId();
	await registerDirectSession(manager, dir, undefined, { registerPostmortem: () => () => {} });
	await startBroker();
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "live" });
	// The broker did not start this process, so it neither closes nor signals it. A direct
	// registration has no SDK endpoint (generation 0), which the broker's endpoint lookup rejects
	// as invalid input before anything is sent; one with an endpoint is refused as `close_refused`.
	const refused = await closeEmbeddedIdleOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 });
	expect(refused).toEqual({ kind: "not_closed", code: "invalid_input" });
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "live" });
	// Nothing registered for a session: a definite answer too, and nothing is started for it.
	expect(
		await closeEmbeddedIdleOwner({
			agentDir: dir,
			sessionId: "1b0f8a52-6a8f-4a59-9d1c-1f3c2d4e5f60",
			timeoutMs: 10_000,
		}),
	).toEqual({ kind: "not_closed", code: "not_found" });
}, 60_000);

test("a real broker closes the idle owner it started, and nobody holds the transcript afterwards", async () => {
	const { dir, cwd, startBroker } = await brokerWorkspace();
	await startBroker();
	const manager = await sharedTranscript(cwd, dir);
	const sessionId = manager.getSessionId();
	await manager.close();
	// What an embedding did before it opened shared transcripts itself: resume through the broker,
	// which starts an owner process that outlives the embedding's own connection.
	const lifecycle = new AgentDirSessionLifecycleService(dir);
	const actor = { id: "embedding", namespace: "embedding-owner-test" };
	const listed = await lifecycle.list({
		actor,
		capability: "session.list",
		target: { cwd, resolveSessionId: sessionId },
	});
	if (!listed.ok || "rows" in listed.result || !listed.result.savedSession)
		throw new Error("The fixture broker did not list the saved transcript");
	const saved = listed.result.savedSession;
	const resumed = await lifecycle.resume({
		actor,
		capability: "session.resume",
		requestKey: crypto.randomUUID(),
		target: {
			sessionId,
			cwd,
			stateRoot: path.join(cwd, ".gjc", "state"),
			sessionPath: saved.path,
			sessionIdentity: saved.identity,
		},
	});
	expect(resumed.ok).toBe(true);
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "live" });
	expect(await closeEmbeddedIdleOwner({ agentDir: dir, sessionId, timeoutMs: 30_000 })).toEqual({ kind: "closed" });
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "none" });
}, 120_000);

/** Registers `sessionId` in the index the way an SDK-hosting terminal does: an endpoint generation and only `hostIncarnation`. */
async function registerHosted(dir: string, cwd: string, sessionId: string, pid: number, hostIncarnation?: string) {
	const index = await new SessionIndex(dir).open();
	await index.append({
		type: "host_registered",
		sessionId,
		locator: await resolveSessionLocator(cwd, dir),
		endpointGeneration: 1,
		pid,
		...(hostIncarnation === undefined ? {} : { hostIncarnation }),
	});
}

test("with no broker, an SDK-hosting terminal's registration is observed like the broker does", async () => {
	const { dir, cwd } = await brokerWorkspace();
	const ask = (sessionId: string) => findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 5_000 });
	const ownIncarnation = processIncarnation(process.pid);
	if (!ownIncarnation) throw new Error("This platform reports no process incarnation");
	// Live: the registered process (this one) runs, with the incarnation it recorded.
	const live = (await sharedTranscript(cwd, dir)).getSessionId();
	await registerHosted(dir, cwd, live, process.pid, ownIncarnation);
	expect(await ask(live)).toEqual({ kind: "live" });
	// Exited: the registered process has finished.
	const child = Bun.spawn(["true"]);
	await child.exited;
	const exited = (await sharedTranscript(cwd, dir)).getSessionId();
	await registerHosted(dir, cwd, exited, child.pid, "darwin:1:1");
	expect(await ask(exited)).toEqual({ kind: "none" });
	// Pid reused: a process runs under that pid, but not the one that registered.
	const reused = (await sharedTranscript(cwd, dir)).getSessionId();
	await registerHosted(dir, cwd, reused, process.pid, "a-process-that-has-exited");
	expect(await ask(reused)).toEqual({ kind: "none" });
	// A running process this one cannot inspect (pid 1 belongs to the system) decides nothing.
	const uninspectable = (await sharedTranscript(cwd, dir)).getSessionId();
	await registerHosted(dir, cwd, uninspectable, 1, "system-process");
	expect(await ask(uninspectable)).toEqual({ kind: "unknown", reason: "broker_absent" });
	// A session never registered is none, and nothing started a broker.
	expect(await ask("1b0f8a52-6a8f-4a59-9d1c-1f3c2d4e5f60")).toEqual({ kind: "none" });
	expect(await Bun.file(path.join(dir, "sdk", "broker.json")).exists()).toBe(false);
}, 60_000);

test("with no broker, a direct registration whose process is gone is none", async () => {
	const { dir, cwd } = await brokerWorkspace();
	const gone = await sharedTranscript(cwd, dir);
	await registerDirectSession(gone, dir, undefined, {
		registerPostmortem: () => () => {},
		processIncarnation: () => "a-process-that-has-exited",
	});
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId: gone.getSessionId(), timeoutMs: 5_000 })).toEqual({
		kind: "none",
	});
}, 60_000);
