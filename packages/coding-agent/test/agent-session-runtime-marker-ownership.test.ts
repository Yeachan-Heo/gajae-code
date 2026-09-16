import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import { sessionRuntimeDir, sessionRuntimeStatePath } from "../src/gjc-runtime/session-layout";
import {
	__sessionStateSidecarTestHooks,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { installExactIdentityNatives } from "./helpers/exact-identity-natives";

// The coordinator pins ONE runtime-state marker per launched session through
// GJC_COORDINATOR_SESSION_STATE_FILE. That pin is process-wide environment, so every
// in-process role-agent/subagent session inherits it. Before #5473 a nested session aimed
// its own lifecycle writes at the parent's marker and the sidecar's identity fence refused
// every one of them (102 rejections in one 15-minute fan-out), while the parent's marker
// stayed untouched — the failure was invisible in the file and the message named nothing.

installExactIdentityNatives();

const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const ORIGINAL_SESSION_ID = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
const tempDirs: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	if (ORIGINAL_SESSION_ID === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = ORIGINAL_SESSION_ID;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: z.object({}),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

/** A nested session exactly as the task tool builds one: its own scope id and taskDepth 1. */
async function nestedSession(cwd: string, scope: string): Promise<AgentSession> {
	const tool = createTool("read");
	const agent = new Agent({
		initialState: {
			model: createModel(),
			systemPrompt: ["nested role agent"],
			tools: [tool],
			messages: [],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		toolRegistry: new Map([[tool.name, tool]]),
		builtinToolIdentities: new Set<object>([tool]),
		providerSessionId: scope,
		taskDepth: 1,
	});
	sessions.push(session);
	return session;
}

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-marker-ownership-"));
	tempDirs.push(root);
	return root;
}

describe("nested session runtime-state marker ownership", () => {
	it("writes its own marker and leaves the parent's pinned marker untouched", async () => {
		const root = await tempRoot();
		const pinnedFile = path.join(root, "projections", "session-states", "parent-session.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = pinnedFile;
		// The coordinator-launched runtime is identified by its own session id, not by a
		// correlation id: the broker sets only the state-file pin.
		delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "parent-session", cwd: root, sessionFile: null },
		);
		const parentMarker = await Bun.file(pinnedFile).text();

		const nested = await nestedSession(root, "child-scope");
		// propagateFailure=true is the terminal path's contract: a refused write rejects.
		await nested.queueCoordinatorRuntimeStatePersistForTests({ type: "turn_start" }, Promise.resolve());

		const ownMarker = path.join(sessionRuntimeDir(root, nested.sessionId), "runtime-state.json");
		expect(JSON.parse(await Bun.file(ownMarker).text())).toMatchObject({
			session_id: "child-scope",
			state: "running",
			cwd: path.resolve(root),
		});
		expect(await Bun.file(pinnedFile).text()).toBe(parentMarker);
	});

	it("follows a nested session's committed move without reading the parent's pinned marker", async () => {
		const root = await tempRoot();
		const pinnedFile = path.join(root, "projections", "session-states", "parent-session.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = pinnedFile;
		delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "parent-session", cwd: root, sessionFile: null },
		);
		const parentMarker = await Bun.file(pinnedFile).text();

		// The committed-move listeners used to resolve the marker from the raw process pin, so a
		// nested session read the parent's marker and its own move was refused as a foreign
		// session (#5473). Ownership now decides, so the nested marker travels with the cwd.
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const nested = await nestedSession(launcher, "child-scope");
		await nested.queueCoordinatorRuntimeStatePersistForTests({ type: "turn_start" }, Promise.resolve());

		await nested.sessionManager.moveTo(target);

		expect(JSON.parse(await Bun.file(sessionRuntimeStatePath(target, "child-scope")).text())).toMatchObject({
			session_id: "child-scope",
			cwd: path.resolve(target),
			state: "running",
		});
		expect(await Bun.file(pinnedFile).text()).toBe(parentMarker);
	});

	it("recovers a nested session's own marker when the first relocation fails", async () => {
		const root = await tempRoot();
		const pinnedFile = path.join(root, "projections", "session-states", "parent-session.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = pinnedFile;
		delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "parent-session", cwd: root, sessionFile: null },
		);
		const parentMarker = await Bun.file(pinnedFile).text();

		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const nested = await nestedSession(launcher, "child-scope");
		await nested.queueCoordinatorRuntimeStatePersistForTests({ type: "turn_start" }, Promise.resolve());

		// Fail the primary relocation exactly once. The after-move listener's recovery retry
		// must then resolve the marker THIS session owns rather than the process pin, or the
		// nested marker stays at the launch root and every later write is refused (#5473).
		let relocationAttempts = 0;
		__sessionStateSidecarTestHooks.afterRescopeLocksAcquired = () => {
			relocationAttempts += 1;
			if (relocationAttempts === 1) throw new Error("injected primary relocation failure");
		};
		try {
			await nested.sessionManager.moveTo(target).catch(() => undefined);
		} finally {
			__sessionStateSidecarTestHooks.afterRescopeLocksAcquired = undefined;
		}

		expect(relocationAttempts).toBeGreaterThanOrEqual(2);
		expect(JSON.parse(await Bun.file(sessionRuntimeStatePath(target, "child-scope")).text())).toMatchObject({
			session_id: "child-scope",
			cwd: path.resolve(target),
		});
		expect(await Bun.file(pinnedFile).text()).toBe(parentMarker);
		// Recovery must also retire the rescope journals: a surviving journal fences every
		// later persist for this session (the pre-#5473 rejection the finding reproduced).
		expect(fsSync.existsSync(path.join(sessionRuntimeDir(target, "child-scope"), "runtime-state-rescope.json"))).toBe(
			false,
		);
		expect(
			fsSync.existsSync(path.join(sessionRuntimeDir(launcher, "child-scope"), "runtime-state-rescope.json")),
		).toBe(false);
		// ...and a later write must be accepted against the recovered marker.
		await nested.queueCoordinatorRuntimeStatePersistForTests({ type: "turn_start" }, Promise.resolve());
		expect(JSON.parse(await Bun.file(sessionRuntimeStatePath(target, "child-scope")).text())).toMatchObject({
			session_id: "child-scope",
			state: "running",
		});
	});
});
