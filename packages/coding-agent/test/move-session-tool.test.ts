import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { postmortem, Snowflake } from "@gajae-code/utils";
import { FileLockTestHooks } from "../src/config/file-lock";
import { sessionRuntimeDir } from "../src/gjc-runtime/session-layout";
import {
	__sessionStateSidecarTestHooks,
	persistCoordinatorRuntimeStateFromEvent,
	prepareCoordinatorRuntimeStateRescope,
} from "../src/gjc-runtime/session-state-sidecar";
import { syncSkillActiveState } from "../src/skill-state/active-state";
import { moveSessionToolRenderer } from "../src/tools/move-session";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("move_session tool (agent-invokable session rescope)", () => {
	const tempDirs: string[] = [];
	// The accessor's setProjectDir() chdirs the process into the moved
	// directory; tests must restore the original cwd before their temp roots
	// are deleted, or every later shell init in this process fails with a
	// dead getcwd (matches the real /move semantics: the process follows).
	const processCwdAtStart = process.cwd();

	afterEach(() => {
		FileLockTestHooks.afterParentMkdir = undefined;
		__sessionStateSidecarTestHooks.beforePersistFromEvent = undefined;
		__sessionStateSidecarTestHooks.beforeRescopeClear = undefined;
		if (process.cwd() !== processCwdAtStart) {
			process.chdir(processCwdAtStart);
		}
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function makeSession(cwd: string, sessionManager: SessionManager, overrides: Record<string, unknown> = {}) {
		return createAgentSession({
			cwd,
			agentDir: path.dirname(cwd),
			sessionManager,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...overrides,
		});
	}

	it("exposes move_session in a top-level session and moves tool cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(tempDir, "root", "repo-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			expect(session.getToolByName("move_session")).toBeDefined();
			expect(sessionManager.getCwd()).toBe(cwdA);

			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-1", { path: cwdB });

			expect(textContent(result)).toContain(cwdB);
			expect(sessionManager.getCwd()).toBe(cwdB);

			// The bash tool's default cwd follows the move, like /move.
			const bashTool = session.getToolByName("bash")!;
			const pwd = await bashTool.execute("pwd-after-move-session", { command: "pwd" });
			expect(textContent(pwd)).toContain(cwdB);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a committed move relocates coordinator runtime state to the new cwd (shared moveTo seam)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const sessionId = session.sessionId;
			// A running marker at the launch root (as a live turn would have written).
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			const launcherFile = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			expect(fs.existsSync(launcherFile)).toBe(true);

			await session.getToolByName("move_session")!.execute("move-relocates-state", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(cwdB);

			// The after-move listener migrated the payload to the new cwd and cleared the orphan.
			expect(fs.existsSync(launcherFile)).toBe(false);
			const migrated = JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>;
			expect(migrated.cwd).toBe(path.resolve(cwdB));

			// The persist that was previously fenced now succeeds at the new cwd.
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId, cwd: cwdB, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).cwd).toBe(
				path.resolve(cwdB),
			);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a relocation failure still rebinds the postmortem finalizer to the committed cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const registered = new Map<string, Parameters<typeof postmortem.register>[1]>();
		const registerSpy = spyOn(postmortem, "register").mockImplementation((id, callback) => {
			registered.set(id, callback);
			return () => {
				registered.delete(id);
			};
		});
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const sessionId = session.sessionId;
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			FileLockTestHooks.afterParentMkdir = lockPath => {
				if (lockPath.includes(path.join(cwdB, ".gjc")) && lockPath.endsWith("mutation.lock.lock"))
					throw new Error("injected relocation lock failure");
			};

			await session.getToolByName("move_session")!.execute("move-finalizer-rebind", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(cwdB);
			FileLockTestHooks.afterParentMkdir = undefined;
			const finalizer = registered.get("coordinator-runtime-state");
			expect(finalizer).toBeDefined();
			await finalizer!(postmortem.Reason.EXIT);

			expect(fs.existsSync(targetFile)).toBe(true);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).cwd).toBe(
				path.resolve(cwdB),
			);
		} finally {
			FileLockTestHooks.afterParentMkdir = undefined;
			await session.dispose();
			registerSpy.mockRestore();
		}
	}, 20_000);

	it("issue-4629: a move drains admitted old-cwd state and fences queued stale writes before relocation", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const sessionId = session.sessionId;
			const launcherFile = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			const oldPersistStarted = Promise.withResolvers<void>();
			const releaseOldPersist = Promise.withResolvers<void>();
			let blocked = false;
			__sessionStateSidecarTestHooks.beforePersistFromEvent = async (eventType, cwd) => {
				if (blocked || eventType !== "agent_start" || cwd !== cwdA) return;
				blocked = true;
				oldPersistStarted.resolve();
				await releaseOldPersist.promise;
			};
			session.agent.emitExternalEvent({ type: "agent_start" });
			await oldPersistStarted.promise;
			const move = sessionManager.moveTo(cwdB);
			session.agent.emitExternalEvent({ type: "turn_start" });
			let moveSettled = false;
			void move.finally(() => {
				moveSettled = true;
			});
			await Bun.sleep(25);
			expect(moveSettled).toBe(false);

			releaseOldPersist.resolve();
			await move;
			expect(fs.existsSync(launcherFile)).toBe(false);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).event).toBe(
				"move_session",
			);

			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId, cwd: cwdB, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).event).toBe("turn_start");
		} finally {
			__sessionStateSidecarTestHooks.beforePersistFromEvent = undefined;
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: events admitted after the generation bump capture the committed cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const unregister = sessionManager.registerBeforeMoveListener(() => {
			session.agent.emitExternalEvent({ type: "turn_start" });
		});
		try {
			const sessionId = session.sessionId;
			const launcherFile = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);

			await sessionManager.moveTo(cwdB);
			await session.awaitSessionSettlement();
			for (let attempt = 0; attempt < 100; attempt++) {
				const event = (JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).event;
				if (event === "turn_start") break;
				await Bun.sleep(10);
			}

			expect(fs.existsSync(launcherFile)).toBe(false);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).event).toBe("turn_start");
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).cwd).toBe(
				path.resolve(cwdB),
			);
		} finally {
			unregister();
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a terminal event admitted before the barrier drains before relocation", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const releasePersist = Promise.withResolvers<void>();
		try {
			const sessionId = session.sessionId;
			const launcherFile = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			const terminalPersist = session.queueCoordinatorRuntimeStatePersistForTests(
				{ type: "agent_end", messages: [] },
				releasePersist.promise,
			);
			const move = sessionManager.moveTo(cwdB);
			await Bun.sleep(10);
			expect(sessionManager.getCwd()).toBe(cwdA);
			releasePersist.resolve();

			await Promise.race([
				move,
				Bun.sleep(5_000).then(() => {
					throw new Error(`move remained blocked at ${sessionManager.getCwd()}`);
				}),
			]);
			await terminalPersist;
			await Promise.race([
				session.awaitSessionSettlement(),
				Bun.sleep(5_000).then(() => {
					throw new Error("terminal event did not settle after move");
				}),
			]);

			expect(fs.existsSync(launcherFile)).toBe(false);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).state).toBe("completed");
		} finally {
			releasePersist.resolve();
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a parked pre-move agent_end rehomes to the committed cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const sessionId = session.sessionId;
			const launcherFile = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			session.parkAgentEndForCoordinatorPersistForTests({ type: "agent_end", messages: [] });

			await sessionManager.moveTo(cwdB);
			session.flushParkedAgentEndForCoordinatorPersistForTests();
			await session.awaitSessionSettlement();
			for (let attempt = 0; attempt < 100; attempt++) {
				const state = (JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).state;
				if (state === "completed") break;
				await Bun.sleep(10);
			}

			expect(fs.existsSync(launcherFile)).toBe(false);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).state).toBe("completed");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a post-barrier write cannot queue ahead of a delayed pre-barrier reservation", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const releasePreBarrier = Promise.withResolvers<void>();
		try {
			const sessionId = session.sessionId;
			const launcherFile = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const targetFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			const preBarrierPersist = session.queueCoordinatorRuntimeStatePersistForTests(
				{ type: "turn_start" },
				releasePreBarrier.promise,
			);
			const move = sessionManager.moveTo(cwdB);
			await Bun.sleep(10);
			session.agent.emitExternalEvent({ type: "turn_start" });
			await Bun.sleep(10);
			releasePreBarrier.resolve();

			await Promise.race([
				move,
				Bun.sleep(5_000).then(() => {
					throw new Error("move deadlocked behind a deferred post-barrier write");
				}),
			]);
			await preBarrierPersist;
			await session.awaitSessionSettlement();
			for (let attempt = 0; attempt < 100 && !fs.existsSync(targetFile); attempt++) await Bun.sleep(10);

			expect(fs.existsSync(launcherFile)).toBe(false);
			expect((JSON.parse(fs.readFileSync(targetFile, "utf8")) as Record<string, unknown>).cwd).toBe(
				path.resolve(cwdB),
			);
		} finally {
			releasePreBarrier.resolve();
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a second rescope drains the prior move's released-barrier writes", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		const cwdC = path.join(cwdA, "repo-c");
		fs.mkdirSync(cwdB, { recursive: true });
		fs.mkdirSync(cwdC, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const deferredPersistStarted = Promise.withResolvers<void>();
		const releaseDeferredPersist = Promise.withResolvers<void>();
		const unregister = sessionManager.registerBeforeMoveListener(move => {
			if (move.newCwd === path.resolve(cwdB)) session.agent.emitExternalEvent({ type: "turn_start" });
		});
		try {
			const sessionId = session.sessionId;
			const stateA = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
			const stateB = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
			const stateC = path.join(sessionRuntimeDir(cwdC, sessionId), "runtime-state.json");
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			__sessionStateSidecarTestHooks.beforePersistFromEvent = async (eventType, cwd) => {
				if (eventType !== "turn_start" || cwd !== path.resolve(cwdB)) return;
				deferredPersistStarted.resolve();
				await releaseDeferredPersist.promise;
			};

			await sessionManager.moveTo(cwdB);
			await deferredPersistStarted.promise;
			unregister();
			const secondMove = sessionManager.moveTo(cwdC);
			await Bun.sleep(10);
			expect(sessionManager.getCwd()).toBe(path.resolve(cwdB));
			releaseDeferredPersist.resolve();

			await secondMove;
			await session.awaitSessionSettlement();

			expect(fs.existsSync(stateA)).toBe(false);
			expect(fs.existsSync(stateB)).toBe(false);
			expect((JSON.parse(fs.readFileSync(stateC, "utf8")) as Record<string, unknown>).cwd).toBe(path.resolve(cwdC));
			expect(fs.existsSync(path.join(sessionRuntimeDir(cwdC, sessionId), "runtime-state-rescope.json"))).toBe(false);
		} finally {
			unregister();
			releaseDeferredPersist.resolve();
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: a later before-move listener failure clears the prepared recovery journal", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const unregister = sessionManager.registerBeforeMoveListener(() => {
			throw new Error("later listener refused");
		});
		try {
			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow("later listener refused");
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(
				fs.existsSync(path.join(sessionRuntimeDir(cwdB, session.sessionId), "runtime-state-rescope.json")),
			).toBe(false);
		} finally {
			unregister();
			await session.dispose();
		}
	}, 20_000);

	it("retains the coordinator rescope fence when abort journal cleanup fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const unregister = sessionManager.registerBeforeMoveListener(() => {
			throw new Error("later listener refused");
		});
		try {
			__sessionStateSidecarTestHooks.beforeRescopeClear = () => {
				throw new Error("abort journal cleanup exploded");
			};
			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow();
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(
				fs.existsSync(path.join(sessionRuntimeDir(cwdB, session.sessionId), "runtime-state-rescope.json")),
			).toBe(true);
			__sessionStateSidecarTestHooks.beforeRescopeClear = undefined;
			unregister();
			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow("Coordinator rescope barrier is already active");
		} finally {
			__sessionStateSidecarTestHooks.beforeRescopeClear = undefined;
			unregister();
			await session.dispose();
		}
	}, 20_000);

	it("retains the coordinator rescope fence and move identity when journal cleanup fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			__sessionStateSidecarTestHooks.beforeRescopeClear = () => {
				throw new Error("rescope journal cleanup exploded");
			};
			await sessionManager.moveTo(cwdB);

			expect(
				fs.existsSync(path.join(sessionRuntimeDir(cwdB, session.sessionId), "runtime-state-rescope.json")),
			).toBe(true);
			await expect(sessionManager.moveTo(cwdA)).rejects.toThrow("Coordinator rescope barrier is already active");
		} finally {
			__sessionStateSidecarTestHooks.beforeRescopeClear = undefined;
			await session.dispose();
		}
	}, 20_000);

	it("issue-4629: an early before-move failure does not clear a journal this session did not prepare", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const unregister = sessionManager.registerBeforeMoveListener(() => {
			throw new Error("early listener refused");
		});
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const sessionId = session.sessionId;
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId, cwd: cwdA, sessionFile: sessionManager.getSessionFile() ?? null },
			);
			await prepareCoordinatorRuntimeStateRescope({
				sessionId,
				previousCwd: cwdA,
				newCwd: cwdB,
				previousSessionFile: sessionManager.getSessionFile() ?? null,
				newSessionFile: path.join(
					SessionManager.managedDestination(cwdB, tempDir).directory,
					path.basename(sessionManager.getSessionFile()!),
				),
			});
			const journalFile = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state-rescope.json");
			const original = fs.readFileSync(journalFile);

			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow("early listener refused");

			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(fs.readFileSync(journalFile)).toEqual(original);
		} finally {
			unregister();
			await session.dispose();
		}
	}, 20_000);
	it("lets a sequential fenced bash call follow a completed move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-then-bash", { path: "repo-b" });
			const bashTool = session.getToolForExecution("bash")!;
			const pwd = await bashTool.execute("pwd-after-fenced-move", { command: "pwd" });
			expect(textContent(pwd)).toContain("repo-b");
		} finally {
			await session.dispose();
		}
	});

	it("refuses an unreadable target without moving", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const locked = path.join(cwdA, "locked");
		fs.mkdirSync(locked, { recursive: true });
		fs.chmodSync(locked, 0);
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			await expect(moveTool.execute("move-unreadable", { path: "locked" })).rejects.toThrow(
				/access unavailable|permission|EACCES/i,
			);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			fs.chmodSync(locked, 0o755);
			await session.dispose();
		}
	});

	it("resolves a relative target against the current session cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-2", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(repoB);
			const details = (result as { details?: { from?: string; to?: string } }).details ?? {};
			expect(details.from).toBe(cwdA);
			expect(details.to).toBe(repoB);
		} finally {
			await session.dispose();
		}
	});

	it("rejects a missing directory instead of moving", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const missing = path.join(tempDir, "does-not-exist");
			let error: unknown;
			try {
				await moveTool.execute("move-3", { path: missing });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain(missing);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("does not expose move_session in subagent sessions (taskDepth > 0)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			taskDepth: 1,
			currentAgentType: "executor",
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it(
		"does not expose move_session in canonical sub-sessions identified by parentTaskPrefix or currentAgentType alone",
		async () => {
			for (const overrides of [{ parentTaskPrefix: "0-Worker" }, { currentAgentType: "executor" }] as Array<
				Record<string, unknown>
			>) {
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
				tempDirs.push(tempDir);
				const cwdA = path.join(tempDir, "root");
				fs.mkdirSync(cwdA, { recursive: true });

				const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
				const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"], ...overrides });
				try {
					expect(
						session.getToolByName("move_session"),
						`sub-session with ${Object.keys(overrides)[0]} must not expose move_session`,
					).toBeUndefined();
				} finally {
					await session.dispose();
				}
			}
		},
		{ timeout: 15_000 },
	);

	it("refuses to move while a workflow skill is active", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const activated = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === SKILL_PROMPT_MESSAGE_TYPE
				)
					activated.resolve();
			});
			session.agent.emitExternalEvent({
				type: "message_start",
				message: {
					role: "custom",
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: "# Deep Interview",
					display: true,
					details: { name: "deep-interview" },
					attribution: "agent",
					timestamp: Date.now(),
				},
			});
			await activated.promise;
			unsubscribe();
			expect(session.getActiveSkillState()).toMatchObject({ skill: "deep-interview" });

			const moveTool = session.getToolByName("move_session")!;
			let error: unknown;
			try {
				await moveTool.execute("move-during-workflow", { path: "repo-b" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("workflow skill is active");
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("does not expose move_session under a read-only bash restriction profile", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			bashRestrictionProfile: "read-only",
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
	it(
		"does not expose move_session when caller-owned MCP or a frozen workspace tree is bound",
		async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwdA = path.join(tempDir, "root");
			fs.mkdirSync(cwdA, { recursive: true });
			const frozenTree = { cwd: cwdA, entries: [], agentsMdFiles: [] };
			const withTree = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
			const treeSession = await makeSession(cwdA, withTree, {
				toolNames: ["move_session"],
				workspaceTree: frozenTree,
			});
			try {
				expect(treeSession.session.getToolByName("move_session")).toBeUndefined();
			} finally {
				await treeSession.session.dispose();
			}
			const withMcp = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
			const mcpSession = await makeSession(cwdA, withMcp, {
				toolNames: ["move_session"],
				mcpManager: { connectServers() {} },
			});
			try {
				expect(mcpSession.session.getToolByName("move_session")).toBeUndefined();
			} finally {
				await mcpSession.session.dispose();
			}
		},
		{ timeout: 15_000 },
	);
	it("does not expose move_session for an exact MCP config session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });
		const mcpConfigPath = path.join(tempDir, "mcp.json");
		fs.writeFileSync(mcpConfigPath, "{}\n");
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			mcpConfigPath,
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("refuses to rescope outside the current session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const outside = path.join(tempDir, "sibling");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			for (const target of [outside, "..", path.dirname(cwdA), "/"]) {
				let error: unknown;
				try {
					await moveTool.execute(`move-outside-${target}`, { path: target });
				} catch (err) {
					error = err;
				}
				expect(error, `target ${target} must be refused`).toBeDefined();
				expect(String((error as Error)?.message ?? error)).toContain("only narrows");
				expect(sessionManager.getCwd()).toBe(cwdA);
			}
			// A refused move does not consume the one-move bound.
			const repoB = path.join(cwdA, "repo-b");
			fs.mkdirSync(repoB, { recursive: true });
			const result = await moveTool.execute("move-after-refusals", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			expect(textContent(result)).toContain("repo-b");
		} finally {
			await session.dispose();
		}
	});

	it("rejects moving to the current directory itself", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			let error: unknown;
			try {
				await moveTool.execute("move-self", { path: "." });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("nothing to move");
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("allows only one successful move per session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		const deeper = path.join(cwdA, "repo-b", "pkg");
		fs.mkdirSync(deeper, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-first", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));

			let error: unknown;
			try {
				await moveTool.execute("move-second", { path: "pkg" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("only one agent-invoked move");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
		}
	});

	it("canonicalizes a symlinked target to its realpath", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const realRepo = path.join(cwdA, "real-repo");
		const link = path.join(cwdA, "link-repo");
		fs.mkdirSync(realRepo, { recursive: true });
		fs.symlinkSync(realRepo, link);

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-symlink", { path: "link-repo" });
			const canonical = fs.realpathSync(realRepo);
			expect(sessionManager.getCwd()).toBe(canonical);
			const details = (result as { details?: { to?: string } }).details ?? {};
			expect(details.to).toBe(canonical);
		} finally {
			await session.dispose();
		}
	});

	it("rejects an ancestor replaced after canonical descendant validation", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const parent = path.join(cwdA, "parent");
		const parkedParent = path.join(cwdA, "parent-original");
		const target = path.join(parent, "repo");
		const outsideParent = path.join(tempDir, "outside-parent");
		const outsideTarget = path.join(outsideParent, "repo");
		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(outsideTarget, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const originalOpen = SessionManager.openNoFollowDirectory;
		let openCount = 0;
		const openSpy = spyOn(SessionManager, "openNoFollowDirectory").mockImplementation(async dir => {
			openCount += 1;
			if (openCount === 2) {
				fs.renameSync(parent, parkedParent);
				fs.symlinkSync(outsideParent, parent);
			}
			return await originalOpen.call(SessionManager, dir);
		});
		try {
			await expect(
				session.getToolByName("move_session")!.execute("move-ancestor-swap", { path: "parent/repo" }),
			).rejects.toThrow(/identity changed|identity or access unavailable/);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			openSpy.mockRestore();
			await session.dispose();
		}
	}, 20_000);

	it("rejects the launch root being replaced after its physical identity is pinned", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const parkedRoot = path.join(tempDir, "root-original");
		const target = path.join(cwdA, "repo");
		fs.mkdirSync(target, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const originalOpen = SessionManager.openNoFollowDirectory;
		let openCount = 0;
		const openSpy = spyOn(SessionManager, "openNoFollowDirectory").mockImplementation(async dir => {
			openCount += 1;
			if (openCount === 2) {
				fs.renameSync(cwdA, parkedRoot);
				fs.mkdirSync(path.join(cwdA, "repo"), { recursive: true });
			}
			return await originalOpen.call(SessionManager, dir);
		});
		try {
			await expect(
				session.getToolByName("move_session")!.execute("move-root-swap", { path: "repo" }),
			).rejects.toThrow(/identity changed|identity or access unavailable/);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			openSpy.mockRestore();
			await session.dispose();
		}
	}, 20_000);

	it("treats a direct manager symlink alias of the current cwd as the same physical directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const alias = path.join(tempDir, "alias");
		fs.mkdirSync(cwd);
		fs.symlinkSync(cwd, alias);
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));
		try {
			await sessionManager.moveTo(alias);
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(cwd));
		} finally {
			await sessionManager.close();
		}
	});

	it("rejects direct manager moves when the source root is replaced after pinning", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const parkedRoot = path.join(tempDir, "root-original");
		const cwdB = path.join(tempDir, "target");
		fs.mkdirSync(cwdA);
		fs.mkdirSync(cwdB);
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const originalOpen = SessionManager.openNoFollowDirectory;
		let openCount = 0;
		const openSpy = spyOn(SessionManager, "openNoFollowDirectory").mockImplementation(async dir => {
			openCount += 1;
			if (openCount === 2) {
				fs.renameSync(cwdA, parkedRoot);
				fs.mkdirSync(cwdA);
			}
			return await originalOpen.call(SessionManager, dir);
		});
		try {
			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow(/replaced path|identity changed/);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			openSpy.mockRestore();
			await sessionManager.close();
		}
	});

	it("rejects direct manager moves when the target is substituted before auto-pinning", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const targetParent = path.join(tempDir, "target-parent");
		const parkedParent = path.join(tempDir, "target-parent-original");
		const cwdB = path.join(targetParent, "target");
		const outsideParent = path.join(tempDir, "outside-parent");
		fs.mkdirSync(cwdA);
		fs.mkdirSync(cwdB, { recursive: true });
		fs.mkdirSync(path.join(outsideParent, "target"), { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const originalOpen = SessionManager.openNoFollowDirectory;
		let openCount = 0;
		const openSpy = spyOn(SessionManager, "openNoFollowDirectory").mockImplementation(async dir => {
			openCount += 1;
			if (openCount === 2) {
				fs.renameSync(targetParent, parkedParent);
				fs.symlinkSync(outsideParent, targetParent);
			}
			return await originalOpen.call(SessionManager, dir);
		});
		try {
			await expect(sessionManager.moveTo(cwdB)).rejects.toThrow(/target identity changed/);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			openSpy.mockRestore();
			await sessionManager.close();
		}
	});

	it("accepts a child literally named with leading dots (not a parent escape)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const dotted = path.join(cwdA, "..dots");
		fs.mkdirSync(dotted, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-dotted-child", { path: "..dots" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(dotted));
			expect(textContent(result)).toContain("..dots");
		} finally {
			await session.dispose();
		}
	});
	it("does not expose move_session under bashAllowedPrefixes", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			bashAllowedPrefixes: ["/usr/bin"],
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("refuses to move when a restored workflow is active without a live prompt marker", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		await syncSkillActiveState({
			cwd: cwdA,
			sessionId: sessionManager.getSessionId(),
			skill: "deep-interview",
			phase: "interview",
			active: true,
		});
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			expect(session.getActiveSkillState()).toBeUndefined();
			expect(session.getEffectiveActiveWorkflowSkillState()).toMatchObject({ skill: "deep-interview" });
			const moveTool = session.getToolByName("move_session")!;
			let error: unknown;
			try {
				await moveTool.execute("move-restored-workflow", { path: "repo-b" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("workflow skill is active");
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("queues an unrelated cwd transition instead of skipping the lock", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const hold = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		let secondEntered = false;
		const first = sessionManager.runExclusiveCwdTransition(async () => {
			firstEntered.resolve();
			await hold.promise;
		});
		await firstEntered.promise;
		const second = sessionManager.runExclusiveCwdTransition(async () => {
			secondEntered = true;
		});
		await Bun.sleep(40);
		expect(secondEntered).toBe(false);
		hold.resolve();
		await Promise.all([first, second]);
		expect(secondEntered).toBe(true);
		await sessionManager.close();
	});

	it("serializes overlapping model and SessionManager moves", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		const repoC = path.join(cwdA, "repo-c");
		fs.mkdirSync(repoB, { recursive: true });
		fs.mkdirSync(repoC, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const hold = Promise.withResolvers<void>();
			const firstEntered = Promise.withResolvers<void>();
			const first = sessionManager.runExclusiveCwdTransition(async () => {
				firstEntered.resolve();
				await hold.promise;
				await sessionManager.moveTo(repoB);
			});
			await firstEntered.promise;
			let acpDone = false;
			const acp = sessionManager.moveTo(repoC).then(() => {
				acpDone = true;
			});
			await Bun.sleep(40);
			expect(acpDone).toBe(false);
			hold.resolve();
			await first;
			await acp;
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoC));
		} finally {
			await session.dispose();
		}
	});
	it("does not steal process cwd from a sibling session launched at the same root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		// Two sessions sharing ONE root: `process.cwd() === session.cwd` holds for
		// both, so an inferred ownership check would let the second session chdir
		// the process out from under the first.
		const managerA = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const managerB = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const ownsA = SessionManager.claimProcessCwdOwnership(managerA);
		expect(ownsA).toBe(true);
		// The sibling cannot take the claim while the first owner is alive.
		expect(SessionManager.claimProcessCwdOwnership(managerB)).toBe(false);
		const { session } = await makeSession(cwdA, managerB, { toolNames: ["move_session"] });
		const processBefore = process.cwd();
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-no-steal", { path: "repo-b" });
			// The non-owner's session moved, but the shared process cwd is untouched.
			expect(managerB.getCwd()).toBe(fs.realpathSync(repoB));
			expect(process.cwd()).toBe(processBefore);
			expect(managerA.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
			await managerA.close();
		}
	});

	it("re-enters nested read leases while a writer is queued and releases after abort", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const outerEntered = Promise.withResolvers<void>();
		const allowNested = Promise.withResolvers<void>();
		const nestedEntered = Promise.withResolvers<void>();
		const outer = sessionManager.runWithCwdReadLease(async () => {
			outerEntered.resolve();
			await allowNested.promise;
			await expect(
				sessionManager.runWithCwdReadLease(async () => {
					nestedEntered.resolve();
					throw new Error("nested tool aborted");
				}),
			).rejects.toThrow("nested tool aborted");
		});
		await outerEntered.promise;
		const writer = sessionManager.runExclusiveCwdTransition(() => sessionManager.moveTo(repoB));
		await Bun.sleep(20);
		allowNested.resolve();
		await nestedEntered.promise;
		await outer;
		await writer;
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		await sessionManager.close();
	});

	it("releases process-cwd ownership when construction fails before AgentSession", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = process.cwd();
		const failedManager = SessionManager.inMemory(cwdA);
		try {
			await expect(
				makeSession(cwdA, failedManager, {
					agentDir: tempDir,
					extensions: [
						() => {
							throw new Error("construction failed");
						},
					],
				}),
			).rejects.toThrow("construction failed");
			expect(SessionManager.isProcessCwdOwner(failedManager)).toBe(false);
			const replacementManager = SessionManager.inMemory(cwdA);
			const { session } = await makeSession(cwdA, replacementManager, {
				agentDir: tempDir,
				toolNames: ["move_session"],
			});
			try {
				expect(SessionManager.isProcessCwdOwner(replacementManager)).toBe(true);
			} finally {
				await session.dispose();
			}
			await replacementManager.close();
		} finally {
			await failedManager.close();
		}
	});

	it("holds a cwd read lease across a tool's whole execution, not just its admission", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		fs.writeFileSync(path.join(cwdA, "marker-root"), "root");
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			const bashTool = session.getToolForExecution("bash")!;
			// Admit the command FIRST, then start the move while it is mid-flight:
			// this is the window in which a check-then-yield fence would let a
			// root-A command execute in root B.
			const bashRun = bashTool.execute("pwd-mid-move", { command: "sleep 0.3; pwd; ls marker-root" });
			await Bun.sleep(60);
			const moveStarted = sessionManager.runExclusiveCwdTransition(async () => {
				await sessionManager.moveTo(repoB);
			});
			const bashResult = await bashRun;
			const output = textContent(bashResult as { content?: Array<{ type: string; text?: string }> });
			// The command ran entirely in root A: it saw root A's cwd and its marker.
			expect(output).toContain(fs.realpathSync(cwdA));
			expect(output).toContain("marker-root");
			expect(output).not.toContain("No such file");
			await moveStarted;
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
		}
	});

	it("fences an async bash job to the cwd it was admitted for", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session", "bash"],
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
		});
		try {
			const bashTool = session.getToolForExecution("bash")!;
			// The async job is admitted (and its cwd captured) while the session is
			// still at root A; it then outlives the tool call.
			const started = await bashTool.execute("async-pwd", {
				command: "sleep 0.4; pwd",
				async: true,
			});
			const jobId = (started as { details?: { async?: { jobId?: string } } }).details?.async?.jobId;
			expect(typeof jobId).toBe("string");
			// Move the session while the admitted job is still running.
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-during-async", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();
			let output = "";
			for (let attempt = 0; attempt < 80; attempt++) {
				const job = manager!.getJob(jobId!);
				if (job && (job.status === "completed" || job.status === "failed")) {
					output = job.resultText ?? manager!.readOutputSince(jobId!, 0)?.text ?? "";
					break;
				}
				await Bun.sleep(50);
			}
			expect(output.length).toBeGreaterThan(0);
			// The job ran in the cwd it was ADMITTED for, not the post-move cwd:
			// a job admitted against root A must never silently execute in root B.
			expect(output).toContain(fs.realpathSync(cwdA));
			expect(output.trim().endsWith(fs.realpathSync(repoB))).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("makes a writer wait for an outstanding read lease instead of committing under it", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const releaseReader = Promise.withResolvers<void>();
		const readerEntered = Promise.withResolvers<void>();
		let cwdSeenAtRelease = "";
		const reader = sessionManager.runWithCwdReadLease(async () => {
			readerEntered.resolve();
			await releaseReader.promise;
			cwdSeenAtRelease = sessionManager.getCwd();
		});
		await readerEntered.promise;
		let moveCommitted = false;
		const writer = sessionManager.runExclusiveCwdTransition(async () => {
			await sessionManager.moveTo(repoB);
			moveCommitted = true;
		});
		await Bun.sleep(50);
		// Writer is queued behind the live lease, so cwd is still root A.
		expect(moveCommitted).toBe(false);
		expect(sessionManager.getCwd()).toBe(cwdA);
		releaseReader.resolve();
		await reader;
		await writer;
		expect(cwdSeenAtRelease).toBe(cwdA);
		expect(moveCommitted).toBe(true);
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		await sessionManager.close();
	});

	it("does not starve a queued writer behind a stream of new readers", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const releaseFirst = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const firstReader = sessionManager.runWithCwdReadLease(async () => {
			firstEntered.resolve();
			await releaseFirst.promise;
		});
		await firstEntered.promise;
		const writer = sessionManager.runExclusiveCwdTransition(() => sessionManager.moveTo(repoB));
		await Bun.sleep(20);
		// Readers arriving after the writer was announced must queue behind it.
		const lateReaderCwds: string[] = [];
		const lateReaders = [0, 1, 2].map(() =>
			sessionManager.runWithCwdReadLease(async () => {
				lateReaderCwds.push(sessionManager.getCwd());
			}),
		);
		await Bun.sleep(30);
		expect(lateReaderCwds).toEqual([]);
		releaseFirst.resolve();
		await firstReader;
		await writer;
		await Promise.all(lateReaders);
		// Every late reader observed the POST-move cwd, proving the writer went first.
		expect(lateReaderCwds).toHaveLength(3);
		for (const seen of lateReaderCwds) expect(seen).toBe(fs.realpathSync(repoB));
		await sessionManager.close();
	});

	it("keeps a committed move when abort and dispose race it", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const moveTool = session.getToolByName("move_session")!;
		const moving = moveTool.execute("move-abort-dispose", { path: "repo-b" });
		session.agent.abort();
		const disposed = session.dispose();
		await expect(moving).resolves.toBeDefined();
		await disposed;
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
	});

	it("rejects a cwd move fenced after teardown without waiting for active readers", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(cwd);
		const readerStarted = Promise.withResolvers<void>();
		const releaseReader = Promise.withResolvers<void>();
		const reader = sessionManager.runWithCwdReadLease(async () => {
			readerStarted.resolve();
			await releaseReader.promise;
		});
		await readerStarted.promise;

		await sessionManager.closeCwdMoveAdmission();
		const started = Date.now();
		await expect(sessionManager.moveTo(cwd)).rejects.toThrow("Session cwd move admission is closed.");
		expect(Date.now() - started).toBeLessThan(1_000);

		releaseReader.resolve();
		await reader;
		await sessionManager.close();
	});

	it("cancels a reader-blocked cwd writer and rejects later writers without delaying close", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		const repoB = path.join(cwd, "repo-b");
		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));
		const readerStarted = Promise.withResolvers<void>();
		const releaseReader = Promise.withResolvers<void>();
		const reader = sessionManager.runWithCwdReadLease(async () => {
			readerStarted.resolve();
			await releaseReader.promise;
		});
		await readerStarted.promise;

		const pendingMove = sessionManager.moveTo(repoA);
		const pendingMoveResult = pendingMove.then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);
		const started = Date.now();
		const admissionClose = sessionManager.closeCwdMoveAdmission();
		await expect(sessionManager.moveTo(repoB)).rejects.toThrow("Session cwd move admission is closed.");
		await admissionClose;
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(await pendingMoveResult).toMatchObject({
			status: "rejected",
			error: { message: "Session cwd move admission is closed." },
		});

		releaseReader.resolve();
		await reader;
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(cwd));
		await sessionManager.close();
	});

	it("cancels a cwd writer queued behind an active writer when admission closes", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		const repoB = path.join(cwd, "repo-b");
		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));
		const activeStarted = Promise.withResolvers<void>();
		const releaseActive = Promise.withResolvers<void>();
		const active = sessionManager.runExclusiveCwdMoveTransition(async () => {
			activeStarted.resolve();
			await releaseActive.promise;
		});
		await activeStarted.promise;

		const queued = sessionManager.moveTo(repoA).then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);
		await sessionManager.closeCwdMoveAdmission();
		releaseActive.resolve();
		await active;

		expect(await queued).toMatchObject({
			status: "rejected",
			error: { message: "Session cwd move admission is closed." },
		});
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(cwd));
		await sessionManager.close();
	});

	it("closeStrict fences a queued cwd move before releasing manager ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		fs.mkdirSync(repoA, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));
		const activeStarted = Promise.withResolvers<void>();
		const releaseActive = Promise.withResolvers<void>();
		const active = sessionManager.runExclusiveCwdMoveTransition(async () => {
			activeStarted.resolve();
			await releaseActive.promise;
		});
		await activeStarted.promise;
		const queued = sessionManager.moveTo(repoA).then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);

		const closing = sessionManager.closeStrict();
		releaseActive.resolve();
		await active;

		expect(await queued).toMatchObject({
			status: "rejected",
			error: { message: "Session cwd move admission is closed." },
		});
		expect(await closing).toEqual({ kind: "closed" });
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(cwd));
	});

	it("close fences queued cwd moves and waits for an admitted reader", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		fs.mkdirSync(repoA, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));
		const readerStarted = Promise.withResolvers<void>();
		const releaseReader = Promise.withResolvers<void>();
		const reader = sessionManager.runWithCwdReadLease(async () => {
			readerStarted.resolve();
			await releaseReader.promise;
		});
		await readerStarted.promise;
		const queued = sessionManager.moveTo(repoA).then(
			() => ({ status: "fulfilled" as const }),
			error => ({ status: "rejected" as const, error }),
		);
		let closeSettled = false;
		const closing = sessionManager.close().finally(() => {
			closeSettled = true;
		});

		await Promise.resolve();
		expect(closeSettled).toBe(false);
		expect(await queued).toMatchObject({
			status: "rejected",
			error: { message: "Session cwd move admission is closed." },
		});
		await expect(sessionManager.runWithCwdReadLease(async () => {})).rejects.toThrow("Session manager is closing.");

		releaseReader.resolve();
		await reader;
		await closing;
		expect(closeSettled).toBe(true);
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(cwd));
	});

	it("suspends its own cwd read lease while acquiring move authority", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		fs.mkdirSync(repoA, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));

		await sessionManager.runWithCwdReadLease(() => sessionManager.moveTo(repoA));

		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoA));
		await sessionManager.close();
	});

	it("settles concurrent nested moves without restoring a shared lease early", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		const repoB = path.join(cwd, "repo-b");
		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));

		const outcomes = await sessionManager.runWithCwdReadLease(async () =>
			Promise.all(
				[repoA, repoB].map(target =>
					sessionManager.moveTo(target).then(
						() => "fulfilled" as const,
						() => "rejected" as const,
					),
				),
			),
		);

		expect(outcomes).toEqual(["fulfilled", "fulfilled"]);
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		await sessionManager.runWithCwdReadLease(async () => {});
		await sessionManager.close();
	});

	it("does not resurrect a read lease in a detached nested move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		const repoB = path.join(cwd, "repo-b");
		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));

		let detachedMove!: Promise<void>;
		await sessionManager.runWithCwdReadLease(async () => {
			detachedMove = Promise.resolve().then(() => sessionManager.moveTo(repoA));
		});
		await detachedMove;
		await sessionManager.moveTo(repoB);
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		await sessionManager.close();
	});

	it("retains outer move admission after a reentrant inner transition", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		fs.mkdirSync(repoA, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));

		await sessionManager.runExclusiveCwdMoveTransition(async () => {
			await sessionManager.runExclusiveCwdMoveTransition(async () => {});
			await sessionManager.closeCwdMoveAdmission();
			await sessionManager.moveTo(repoA);
		});

		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoA));
		await sessionManager.close();
	});

	it("rejects a nested move while a sibling tool still holds the lease", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "root");
		const repoA = path.join(cwd, "repo-a");
		fs.mkdirSync(repoA, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, tempDir));
		const siblingEntered = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();

		await sessionManager.runWithCwdReadLease(async () => {
			const sibling = sessionManager.runWithCwdReadLease(async () => {
				siblingEntered.resolve();
				await releaseSibling.promise;
				return sessionManager.getCwd();
			});
			await siblingEntered.promise;

			const nestedMove = sessionManager
				.runWithCwdReadLease(() => sessionManager.moveTo(repoA))
				.then(
					() => ({ status: "fulfilled" as const }),
					error => ({ status: "rejected" as const, error }),
				);
			expect(await nestedMove).toMatchObject({
				status: "rejected",
				error: {
					message: "Session working directory changed while this tool executed; retry against the new cwd.",
				},
			});
			expect(sessionManager.getCwd()).toBe(cwd);
			releaseSibling.resolve();
			expect(await sibling).toBe(cwd);
		});

		await sessionManager.moveTo(repoA);
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoA));
		await sessionManager.close();
	});

	it("rejects without moving when authority rebinding fails, and keeps launch-root tools", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			// refreshGjcSubskillTools is the first fallible step of authority rebinding,
			// which the accessor runs BEFORE committing the session-file move.
			let calls = 0;
			const original = session.refreshGjcSubskillTools.bind(session);
			session.refreshGjcSubskillTools = async () => {
				calls += 1;
				// Fail the move-to-target rebind; allow the launch-root restore.
				if (calls === 1) throw new Error("subskill rebind exploded");
				return original();
			};
			const moveTool = session.getToolByName("move_session")!;
			await expect(moveTool.execute("move-rebind-fail", { path: "repo-b" })).rejects.toThrow(
				/subskill rebind exploded/,
			);
			// No half-moved session: cwd, process cwd, and generation are unchanged.
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(sessionManager.getCwdGeneration()).toBe(0);
			// The launch-root authority was restored, not left torn down.
			expect(calls).toBe(2);
			// The single-use budget is not consumed by a rejected move: a later
			// successful call must still be admitted.
			const retry = await moveTool.execute("move-rebind-retry", { path: "repo-b" });
			expect(textContent(retry)).toContain("repo-b");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
		}
	});

	it("restores process cwd and retries when flush fails before the durable move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const restoreProcessCwd = process.cwd();
		process.chdir(cwdA);
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const originalFlush = sessionManager.flush.bind(sessionManager);
			let failOnce = true;
			sessionManager.flush = async () => {
				if (failOnce) {
					failOnce = false;
					throw new Error("flush exploded");
				}
				return originalFlush();
			};
			const moveTool = session.getToolByName("move_session")!;
			await expect(moveTool.execute("move-flush-fail", { path: "repo-b" })).rejects.toThrow(/flush exploded/);
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(process.cwd()).toBe(cwdA);
			expect(
				fs.existsSync(path.join(sessionRuntimeDir(repoB, session.sessionId), "runtime-state-rescope.json")),
			).toBe(false);
			const retry = await moveTool.execute("move-flush-retry", { path: "repo-b" });
			expect(textContent(retry)).toContain("repo-b");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
			process.chdir(restoreProcessCwd);
		}
	}, 20_000);

	it("reports a committed move when final move metadata fails after publication", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const originalMoveTo = sessionManager.moveTo.bind(sessionManager);
			sessionManager.moveTo = async (newCwd, options) => {
				await originalMoveTo(newCwd, options);
				throw new Error("post-publication metadata exploded");
			};
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-post-publication-fail", { path: "repo-b" });
			expect(textContent(result)).toContain("repo-b");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			await expect(moveTool.execute("move-post-publication-retry", { path: "repo-b" })).rejects.toThrow(
				/already been rescoped/,
			);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a committed move successful when post-move prompt refresh throws", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			session.refreshBaseSystemPrompt = async () => {
				throw new Error("post-move prompt refresh exploded");
			};
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-refresh-fail", { path: "repo-b" });
			expect(textContent(result)).toContain("repo-b");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			await expect(moveTool.execute("move-refresh-retry", { path: "repo-b" })).rejects.toThrow(
				/already been rescoped/,
			);
		} finally {
			await session.dispose();
		}
	});

	it("re-roots project context files and the workspace tree at the new cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		fs.writeFileSync(path.join(cwdA, "AGENTS.md"), "launcher-root-instructions");
		fs.writeFileSync(path.join(repoB, "AGENTS.md"), "repo-b-instructions");
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		// contextFiles/workspaceTree are NOT injected here: the session must
		// discover them, and re-discover them after the move.
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			contextFiles: undefined,
		});
		try {
			const before = session.systemPrompt.join("\n");
			expect(before).toContain("launcher-root-instructions");
			// repo-b is not on the launch root's ancestor walk, so its instructions
			// are invisible until the session is actually rescoped into it.
			expect(before).not.toContain("repo-b-instructions");
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-context-reroot", { path: "repo-b" });
			await session.refreshBaseSystemPrompt();
			const after = session.systemPrompt.join("\n");
			// The model is now shown the target repo's own project instructions, and
			// the prompt describes the new cwd rather than the retired launcher root.
			expect(after).toContain("repo-b-instructions");
			expect(after).toContain(fs.realpathSync(repoB));
			// The ancestor AGENTS.md legitimately still applies after narrowing.
			expect(after).toContain("launcher-root-instructions");
		} finally {
			await session.dispose();
		}
	});

	it("does not fail the committed move when SSH refresh throws", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			session.refreshSshTool = async () => {
				throw new Error("ssh refresh exploded");
			};
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-ssh-fail", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			expect(textContent(result)).toContain("repo-b");
		} finally {
			await session.dispose();
		}
	});

	it("refuses a move when the no-follow target is replaced after the handle is opened", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		const outside = path.join(tempDir, "outside");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const handle = await SessionManager.openNoFollowDirectory(repoB);
		try {
			const opened = await handle.stat({ bigint: true });
			fs.rmdirSync(repoB);
			fs.symlinkSync(outside, repoB);
			await expect(
				sessionManager.moveTo(repoB, {
					expectedIdentity: { dev: opened.dev, ino: opened.ino },
					targetHandle: handle,
				}),
			).rejects.toThrow(/replaced path|identity changed/);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await handle.close().catch(() => {});
			await sessionManager.close();
		}
	});

	it("refuses to publish a process cwd whose identity is not the validated target", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const validated = path.join(tempDir, "validated");
		const other = path.join(tempDir, "other");
		fs.mkdirSync(validated, { recursive: true });
		fs.mkdirSync(other, { recursive: true });
		const validatedIdentity = fs.statSync(validated, { bigint: true });
		const restore = process.cwd();
		try {
			// The process landed somewhere OTHER than the pinned directory, which is
			// what a post-validation path replacement produces for a name-based chdir.
			process.chdir(other);
			await expect(
				SessionManager.assertProcessCwdIdentity({ dev: validatedIdentity.dev, ino: validatedIdentity.ino }),
			).rejects.toThrow(/not the validated target directory/);
			// The same assertion passes when the process really is in the pinned dir.
			process.chdir(validated);
			await SessionManager.assertProcessCwdIdentity({ dev: validatedIdentity.dev, ino: validatedIdentity.ino });
		} finally {
			process.chdir(restore);
		}
	});

	it("sanitizes control characters in the renderer preview and error output", () => {
		const dirty = "repo-\tname\x1b[31mred";
		const preview = moveSessionToolRenderer.renderCall({ path: dirty }).render(200).join("\n");
		expect(preview).not.toContain("\t");
		expect(preview).not.toContain("\x1b");
		expect(preview).toContain("move_session");
		const failed = moveSessionToolRenderer
			.renderResult({ isError: true, details: { from: dirty, to: dirty } }, { expanded: false, isPartial: false }, {
				fg: (_k: string, text: string) => text,
			} as never)
			.render(200)
			.join("\n");
		expect(failed).toContain("move_session failed");
		expect(failed).not.toContain("\x1b");
	});
});
