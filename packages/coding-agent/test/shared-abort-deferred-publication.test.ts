import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AsyncJobManager } from "../src/async";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import { withManagedSessionTransaction } from "../src/session/internal/managed-session-transaction";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

// A `!`/`$` result recorded while a turn streams is deferred and published through the
// shared lease when the turn ends. A transition that leaves the session (`/new`,
// `/resume`) must land those results once in the session they were recorded in, even
// while a peer holds the lease, and never in its successor.

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const stores: AuthStorage[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const shellResult = (output: string) => ({
	output,
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: output.length,
	outputLines: 1,
	outputBytes: output.length,
	displayOutputs: [],
	stdinRequested: false,
});

/**
 * A root interactive shared-append session whose model replies to a turn after
 * `replyDelayMs`. `ownerShutdown` adds the agent id and owned async job manager that
 * `createAgentSession` installs, which routes `/new` through its owner-shutdown branch.
 */
async function fixture(replyDelayMs: number, ownerShutdown: boolean) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-abort-deferred-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	const mock = createMockModel({
		handler: context => ({
			content: ["streamed reply"],
			// Seeding a resume target replies at once; the turn under test streams for `replyDelayMs`.
			delayMs: JSON.stringify(context.messages.at(-1)).includes("seed") ? 0 : replyDelayMs,
		}),
	});
	auth.setRuntimeApiKey(mock.model.provider, "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	// `/resume` restores the session model through the registry; resolve the mock there.
	const find = registry.find.bind(registry);
	vi.spyOn(registry, "find").mockImplementation((provider, id, credentialSessionId) =>
		provider === mock.model.provider && id === mock.model.id ? mock.model : find(provider, id, credentialSessionId),
	);
	const getAll = registry.getAll.bind(registry);
	vi.spyOn(registry, "getAll").mockImplementation(credentialSessionId => [mock.model, ...getAll(credentialSessionId)]);
	const getAvailable = registry.getAvailable.bind(registry);
	vi.spyOn(registry, "getAvailable").mockImplementation(credentialSessionId => [
		mock.model,
		...getAvailable(credentialSessionId),
	]);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: registry,
		rootInteractiveSharedAppend: true,
		...(ownerShutdown
			? {
					agentId: "deferred-transition",
					ownedAsyncJobManager: new AsyncJobManager({ maxRunningJobs: 1, onJobComplete: () => {} }),
					disposeAsyncJobManager: true,
				}
			: {}),
		thinkingLevel: ThinkingLevel.Off,
	});
	sessions.push(session);
	return { session, manager };
}

/**
 * When the first deferred command result starts publishing, take the session's real
 * transaction lock as a peer writer would, so the publication waits inside the lease.
 */
function contendLeaseOnFirstDeferredResult(manager: SessionManager) {
	const append = manager.appendMessageSharingSession.bind(manager);
	const attempts = new Map<string, number>();
	const contended = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held: Promise<void> | undefined;
	vi.spyOn(manager, "appendMessageSharingSession").mockImplementation(async message => {
		if (message.role === "pythonExecution") {
			attempts.set(message.code, (attempts.get(message.code) ?? 0) + 1);
			// The peer's lease refuses this kind outright.
			if (message.code === "refused") return { kind: "rejected", error: new Error("lease refused") };
		}
		if (message.role === "bashExecution" && !held) {
			const acquired = Promise.withResolvers<void>();
			held = withManagedSessionTransaction(
				{
					locksDirectory: managedSessionTransactionLocksDirectory(path.dirname(manager.getSessionFile()!)),
					sessionId: manager.getSessionId(),
				},
				async () => {
					acquired.resolve();
					await release.promise;
				},
			);
			await acquired.promise;
			contended.resolve();
		}
		return append(message);
	});
	return {
		attempts,
		contended: contended.promise,
		release: async () => {
			release.resolve();
			await held;
		},
	};
}

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const ROWS = ["first deferred output", "second deferred output"];

describe.each([
	{ branch: "no-lease", ownerShutdown: false },
	{ branch: "owner-shutdown", ownerShutdown: true },
])("deferred command results across a session transition ($branch)", ({ ownerShutdown }) => {
	for (const shape of ["mid-stream", "after the turn ended"] as const) {
		for (const transition of ["/new", "/resume"] as const) {
			it(`${transition} ${shape} keeps them in the session that recorded them`, async () => {
				const f = await fixture(shape === "mid-stream" ? 60_000 : 20, ownerShutdown);
				let resumeTarget: string | undefined;
				if (transition === "/resume") {
					await f.session.prompt("seed the resume target");
					await f.session.awaitSessionSettlement();
					resumeTarget = f.manager.getSessionFile()!;
					expect(await f.session.newSession()).toBe(true);
				}
				const recordedIn = f.manager.getSessionFile()!;
				const turn = f.session.prompt("start a turn").catch((error: unknown) => error);
				await until(() => f.session.isStreaming, "the turn to stream");
				const lease = contendLeaseOnFirstDeferredResult(f.manager);
				const notices: string[] = [];
				f.session.subscribe(event => {
					if (event.type === "notice") notices.push(event.message);
				});
				f.session.recordBashResult("first", shellResult(ROWS[0]!));
				f.session.recordBashResult("second", shellResult(ROWS[1]!));
				// A Python result the lease refuses, and one queued behind it.
				f.session.recordPythonResult("refused", shellResult("refused python output"));
				f.session.recordPythonResult("behind", shellResult("behind python output"));
				// Mid-stream, the transition's abort ends the turn; otherwise the turn ends
				// on its own and its deferred results are already publishing.
				if (shape === "after the turn ended") await lease.contended;
				const switched = transition === "/new" ? f.session.newSession() : f.session.switchSession(resumeTarget!);
				await lease.contended;
				await Bun.sleep(300);
				await lease.release();
				expect(await switched).toBe(true);
				await turn;
				await f.session.awaitSessionSettlement();
				await f.manager.flush();

				const successor = f.manager.getSessionFile()!;
				expect(successor).not.toBe(recordedIn);
				const recorded = await Bun.file(recordedIn).text();
				const successorText = await Bun.file(successor)
					.text()
					.catch(() => "");
				const successorAgent = JSON.stringify(f.session.agent.state.messages);
				for (const row of ROWS) {
					expect(occurrences(recorded, row)).toBe(1);
					expect(occurrences(successorText, row)).toBe(0);
					expect(occurrences(successorAgent, row)).toBe(0);
				}
				expect(f.session.hasPendingBashMessages).toBe(false);
				// Refused since the transition began (by its abort or the drain it joined), the
				// Python kind is not attempted again: the row behind is dropped with its notice.
				expect({ behind: lease.attempts.get("behind") ?? 0, notices }).toEqual({
					behind: 0,
					notices: [
						"Could not save the deferred command result to this session: lease refused",
						"Could not save the deferred command result to this session: an earlier command result could not be saved",
					],
				});
			});
		}
	}

	it("/new saves still-queued results to the session they were recorded in", async () => {
		const f = await fixture(20, ownerShutdown);
		const append = f.manager.appendMessageSharingSession.bind(f.manager);
		let refusedAttempts = 0;
		vi.spyOn(f.manager, "appendMessageSharingSession").mockImplementation(async message => {
			if (message.role === "pythonExecution" && message.code === "throwing") throw new Error("lease writer crashed");
			if (message.role !== "bashExecution" || message.command !== "refused") return append(message);
			refusedAttempts++;
			return { kind: "rejected", error: new Error("lease refused") };
		});
		// A prompt's drain refuses one result (its notice is the report) and keeps the
		// result after it queued behind it, unattempted...
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		f.session.recordBashResult("refused", shellResult("refused deferred output"));
		f.session.recordBashResult("blocked", shellResult("blocked deferred output"));
		Reflect.deleteProperty(f.session, "isStreaming");
		await expect(f.session.prompt("drain the refused result")).rejects.toThrow(/Failed to persist 2 of 2/);
		// ...and a later result is deferred that no drain has claimed yet.
		Object.defineProperty(f.session, "isStreaming", { configurable: true, value: true });
		const persisted = vi.fn();
		f.session.recordBashResult("queued", shellResult("queued deferred output"), { onPersisted: persisted });
		// Two Python results the transition cannot save: one whose save throws, one behind it.
		f.session.recordPythonResult("throwing", shellResult("throwing python output"));
		f.session.recordPythonResult("behind", shellResult("behind python output"));
		Reflect.deleteProperty(f.session, "isStreaming");
		expect(f.session.hasPendingBashMessages).toBe(true);
		const recordedIn = f.manager.getSessionFile()!;
		const attemptsBeforeNew = refusedAttempts;
		const notices: string[] = [];
		f.session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		expect(await f.session.newSession()).toBe(true);
		expect(f.session.hasPendingBashMessages).toBe(false);
		expect(persisted).toHaveBeenCalledTimes(1);
		// The transition does not retry the refused result, but saves the one blocked behind it.
		expect(refusedAttempts).toBe(attemptsBeforeNew);
		// Each Python result it could not save is reported, the thrown save included.
		expect(notices).toEqual([
			"Could not save the deferred command result to this session: lease writer crashed",
			"Could not save the deferred command result to this session: an earlier command result could not be saved",
		]);
		await f.session.prompt("first prompt in the new session");
		await f.session.awaitSessionSettlement();
		await f.manager.flush();
		const recorded = await Bun.file(recordedIn).text();
		const successor = await Bun.file(f.manager.getSessionFile()!).text();
		const successorAgent = JSON.stringify(f.session.agent.state.messages);
		for (const row of ["blocked deferred output", "queued deferred output"]) {
			expect(occurrences(recorded, row)).toBe(1);
			expect(occurrences(successor, row)).toBe(0);
			expect(occurrences(successorAgent, row)).toBe(0);
		}
	});

	for (const transition of ["fork", "branch", "handoff"] as const) {
		it(`${transition} after the turn ended keeps them in the session that recorded them`, async () => {
			const f = await fixture(20, ownerShutdown);
			vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue from here");
			const recordedIn = f.manager.getSessionFile()!;
			const turn = f.session.prompt("start a turn").catch((error: unknown) => error);
			await until(() => f.session.isStreaming, "the turn to stream");
			// Fork and branch refuse while a save is in flight, so they follow a turn whose
			// results have been saved; handoff has no such guard and meets a held save.
			const lease = transition === "handoff" ? contendLeaseOnFirstDeferredResult(f.manager) : undefined;
			f.session.recordBashResult("first", shellResult(ROWS[0]!));
			f.session.recordBashResult("second", shellResult(ROWS[1]!));
			if (lease) await lease.contended;
			else await turn;
			const switched =
				transition === "fork"
					? f.session.fork()
					: transition === "branch"
						? f.session.branch(f.session.getUserMessagesForBranching()[0]!.entryId)
						: f.session.handoff();
			if (lease) {
				await Bun.sleep(300);
				await lease.release();
			}
			await switched;
			await turn;
			await f.session.awaitSessionSettlement();
			await f.session.sessionManager.flush();

			const successor = f.session.sessionManager.getSessionFile()!;
			expect(successor).not.toBe(recordedIn);
			const recorded = await Bun.file(recordedIn).text();
			const successorText = await Bun.file(successor)
				.text()
				.catch(() => "");
			const successorAgent = JSON.stringify(f.session.agent.state.messages);
			// A fork copies the predecessor's history, so its rows appear there once as well.
			const inSuccessor = transition === "fork" ? 1 : 0;
			for (const row of ROWS) {
				expect(occurrences(recorded, row)).toBe(1);
				expect(occurrences(successorText, row)).toBe(inSuccessor);
				expect(occurrences(successorAgent, row)).toBe(inSuccessor);
			}
			expect(f.session.hasPendingBashMessages).toBe(false);
		});
	}

	it("tree navigation after the turn ended keeps them on the branch that recorded them", async () => {
		const f = await fixture(20, ownerShutdown);
		const file = f.manager.getSessionFile()!;
		const turn = f.session.prompt("start a turn").catch((error: unknown) => error);
		await until(() => f.session.isStreaming, "the turn to stream");
		const lease = contendLeaseOnFirstDeferredResult(f.manager);
		f.session.recordBashResult("first", shellResult(ROWS[0]!));
		f.session.recordBashResult("second", shellResult(ROWS[1]!));
		await lease.contended;
		// Navigate back to the turn's prompt while its deferred results are still saving.
		const prompt = f.manager
			.getEntries()
			.findLast(entry => entry.type === "message" && entry.message.role === "user")!;
		const navigated = f.session.navigateTree(prompt.id, { summarize: false });
		await Bun.sleep(300);
		await lease.release();
		expect((await navigated).cancelled).toBe(false);
		await turn;
		await f.session.awaitSessionSettlement();
		await f.manager.flush();

		const transcript = await Bun.file(file).text();
		const newLeafContext = JSON.stringify(f.session.agent.state.messages);
		for (const row of ROWS) {
			expect(occurrences(transcript, row)).toBe(1);
			expect(occurrences(newLeafContext, row)).toBe(0);
		}
		expect(f.session.hasPendingBashMessages).toBe(false);
	});
});
