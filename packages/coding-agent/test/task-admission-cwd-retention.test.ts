import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type * as mcp from "../src/runtime-mcp/manager";
import { TaskTool } from "../src/task";
import type { ExecutorOptions } from "../src/task/executor";
import type { SingleResult, TaskParams } from "../src/task/types";
import type { ContextFileEntry, ToolSession } from "../src/tools";

const tempDirs: string[] = [];
const managers: AsyncJobManager[] = [];

async function createCwd(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-admission-${label}-`));
	tempDirs.push(root);
	return root;
}

function createWorkspaceTree(cwd: string, marker: string): NonNullable<ToolSession["workspaceTree"]> {
	return { rootPath: cwd, rendered: marker, truncated: false, totalLines: 1, agentsMdFiles: [] };
}

function makeResult(options: ExecutorOptions, paused = false): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment ?? "",
		description: options.description ?? "",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		...(paused ? { paused: true } : {}),
	};
}

class TestToolSession implements ToolSession {
	cwd: string;
	hasUI = false;
	settings: Settings;
	contextFiles: ContextFileEntry[];
	workspaceTree: NonNullable<ToolSession["workspaceTree"]>;
	serviceTier: NonNullable<ToolSession["serviceTier"]>;
	#sessionId: string;
	#endpointId: string;
	#agentId: string;
	#sessionFile: string;
	#manager: AsyncJobManager;
	#compactContext = "";
	#mcpManager: mcp.MCPManager | undefined = undefined;
	#modelProfileOwnershipMarker: unknown;
	sessionManager = { getModelProfileOwnershipMarker: () => this.#modelProfileOwnershipMarker };

	setModelProfileOwnershipMarker(marker: unknown): void {
		this.#modelProfileOwnershipMarker = marker;
	}

	constructor(options: {
		cwd: string;
		settings: Settings;
		contextFiles: ContextFileEntry[];
		workspaceTree: NonNullable<ToolSession["workspaceTree"]>;
		serviceTier: NonNullable<ToolSession["serviceTier"]>;
		sessionId: string;
		endpointId: string;
		agentId: string;
		manager: AsyncJobManager;
	}) {
		this.cwd = options.cwd;
		this.settings = options.settings;
		this.contextFiles = options.contextFiles;
		this.workspaceTree = options.workspaceTree;
		this.serviceTier = options.serviceTier;
		this.#sessionId = options.sessionId;
		this.#endpointId = options.endpointId;
		this.#agentId = options.agentId;
		this.#sessionFile = path.join(options.cwd, "parent.jsonl");
		this.#manager = options.manager;
	}

	getSessionFile(): string {
		return this.#sessionFile;
	}

	getSessionSpawns(): string {
		return "*";
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getAsyncEndpointId(): string {
		return this.#endpointId;
	}

	getAgentId(): string {
		return this.#agentId;
	}

	getAsyncJobManager(): AsyncJobManager {
		return this.#manager;
	}

	getSessionAgentDir(): string {
		return path.join(this.cwd, ".gjc");
	}

	getCompactContext(): string {
		return this.#compactContext;
	}

	getMcpManager(): mcp.MCPManager | undefined {
		return this.#mcpManager;
	}

	moveTo(options: {
		cwd: string;
		manager?: AsyncJobManager;
		contextFiles: ContextFileEntry[];
		workspaceTree: NonNullable<ToolSession["workspaceTree"]>;
		serviceTier: NonNullable<ToolSession["serviceTier"]>;
		sessionId: string;
		endpointId: string;
		agentId: string;
	}): void {
		this.cwd = options.cwd;
		if (options.manager) this.#manager = options.manager;
		this.contextFiles = options.contextFiles;
		this.workspaceTree = options.workspaceTree;
		this.serviceTier = options.serviceTier;
		this.#sessionId = options.sessionId;
		this.#endpointId = options.endpointId;
		this.#agentId = options.agentId;
		this.#sessionFile = path.join(options.cwd, "parent.jsonl");
	}
}

function createManager(): { endpointId: string; manager: AsyncJobManager } {
	const endpointId = `task-admission-${Snowflake.next()}`;
	const manager = new AsyncJobManager({ maxRunningJobs: 8, onJobComplete: async () => {} });
	if (!AsyncJobManager.registerForEndpoint(endpointId, manager)) throw new Error("Could not register test endpoint.");
	managers.push(manager);
	return { endpointId, manager };
}

function task(id: string, description: string): TaskParams["tasks"][number] {
	return { id, description, assignment: description };
}

async function startTasks(tool: TaskTool, tasks: TaskParams["tasks"]): Promise<string> {
	const result = await tool.execute("task-admission-call", { agent: "architect", tasks } as TaskParams);
	const jobId = result.details?.async?.jobId;
	if (!jobId) throw new Error("Expected an admitted task job.");
	return jobId;
}

function createSettings(maxConcurrency: number, enableLsp: boolean): Settings {
	return Settings.isolated({
		"task.maxConcurrency": maxConcurrency,
		"task.enableLsp": enableLsp,
		"task.isolation.mode": "auto",
	});
}

function contextFile(cwd: string, marker: string): ContextFileEntry[] {
	return [{ path: path.join(cwd, "rules.md"), content: marker }];
}

function createSession(cwd: string, manager: AsyncJobManager, endpointId: string, marker: string): TestToolSession {
	return new TestToolSession({
		cwd,
		settings: createSettings(1, false),
		contextFiles: contextFile(cwd, marker),
		workspaceTree: createWorkspaceTree(cwd, marker),
		serviceTier: marker === "A" ? "flex" : "priority",
		sessionId: `${marker}-session`,
		endpointId,
		agentId: `${marker}-owner`,
		manager,
	});
}

describe("task admission cwd retention", () => {
	afterEach(async () => {
		await Promise.all(managers.splice(0).map(manager => manager.dispose({ timeoutMs: 100 })));
		AsyncJobManager.resetForTests();
		await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it("keeps queued A runs on their admission scope while a new B factory uses B", async () => {
		const cwdA = await createCwd("a");
		const cwdB = await createCwd("b");
		const { endpointId, manager } = createManager();
		const session = createSession(cwdA, manager, endpointId, "A");
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const bEntered = Promise.withResolvers<void>();
		const runs: ExecutorOptions[] = [];
		const runSubprocess = async (options: ExecutorOptions): Promise<SingleResult> => {
			runs.push(options);
			if (options.description === "A-first") {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			if (options.description === "B-new") bEntered.resolve();
			return makeResult(options);
		};
		const oldTool = await TaskTool.create(session, { runSubprocess });

		try {
			await startTasks(oldTool, [task("AFirst", "A-first"), task("AQueued", "A-queued")]);
			await firstEntered.promise;

			const treeB = createWorkspaceTree(cwdB, "tree-B");
			session.moveTo({
				cwd: cwdB,
				contextFiles: contextFile(cwdB, "context-B"),
				workspaceTree: treeB,
				serviceTier: "priority",
				sessionId: "B-session",
				endpointId: "B-endpoint",
				agentId: "B-owner",
			});
			session.settings.set("task.maxConcurrency", 2);
			session.settings.set("task.enableLsp", true);
			const newTool = await TaskTool.create(session, { runSubprocess });
			await startTasks(newTool, [task("BNew", "B-new")]);
			await bEntered.promise;

			const drift = await oldTool.execute("drift-call", {
				agent: "architect",
				tasks: [task("Drift", "must reject")],
			} as TaskParams);
			const driftText = drift.content.find(item => item.type === "text");
			expect(driftText?.text).toContain("Session repository binding rejected before task discovery");
			expect(runs.some(run => run.description === "must reject")).toBe(false);

			releaseFirst.resolve();
			await manager.waitForAll();

			const aRuns = runs.filter(run => run.description?.startsWith("A-"));
			const queued = aRuns.find(run => run.description === "A-queued");
			const bRun = runs.find(run => run.description === "B-new");
			expect(aRuns).toHaveLength(2);
			expect(queued).toBeDefined();
			expect(bRun).toBeDefined();
			for (const run of aRuns) {
				expect(run.cwd).toBe(cwdA);
				expect(run.asyncJobManager).toBe(manager);
				expect(run.settings?.get("task.maxConcurrency")).toBe(1);
				expect(run.settings?.get("task.enableLsp")).toBe(false);
				expect(run.contextFiles?.[0]?.content).toBe("A");
				expect(run.workspaceTree?.rendered).toBe("A");
				expect(run.inheritedServiceTier).toBe("flex");
				expect(run.parentSessionId).toBe("A-session");
				expect(run.parentCredentialSessionId).toBe("A-session");
				expect(run.sessionFile).toStartWith(path.join(cwdA, "parent"));
			}
			expect(bRun?.cwd).toBe(cwdB);
			expect(bRun?.asyncJobManager).toBe(manager);
			expect(bRun?.settings?.get("task.maxConcurrency")).toBe(2);
			expect(bRun?.settings?.get("task.enableLsp")).toBe(true);
			expect(bRun?.contextFiles?.[0]?.content).toBe("context-B");
			expect(bRun?.workspaceTree).toBe(treeB);
			expect(bRun?.inheritedServiceTier).toBe("priority");
			expect(bRun?.parentSessionId).toBe("B-session");
			expect(bRun?.sessionFile).toStartWith(path.join(cwdB, "parent"));

			expect(manager.getSubagentRecords({ ownerId: "A-owner" })).toHaveLength(2);
			expect(manager.getSubagentRecords({ ownerId: "B-owner" })).toHaveLength(1);
		} finally {
			releaseFirst.resolve();
		}
	});

	it("resumes a paused descriptor with its captured cwd, settings, identity, and session file", async () => {
		const cwdA = await createCwd("resume-a");
		const cwdB = await createCwd("resume-b");
		const { endpointId, manager } = createManager();
		const session = createSession(cwdA, manager, endpointId, "A");
		const runs: ExecutorOptions[] = [];
		const runSubprocess = async (options: ExecutorOptions): Promise<SingleResult> => {
			runs.push(options);
			return makeResult(options, runs.length === 1);
		};
		const tool = await TaskTool.create(session, { runSubprocess });

		await startTasks(tool, [task("Paused", "pause-this-run")]);
		await manager.waitForAll();
		const pausedRecord = manager.getSubagentRecords({ ownerId: "A-owner" })[0];
		expect(pausedRecord?.status).toBe("paused");
		if (!pausedRecord) throw new Error("Expected a retained paused task record.");
		const original = runs[0];
		if (!original) throw new Error("Expected initial executor invocation.");

		const treeB = createWorkspaceTree(cwdB, "tree-B");
		session.moveTo({
			cwd: cwdB,
			contextFiles: contextFile(cwdB, "context-B"),
			workspaceTree: treeB,
			serviceTier: "priority",
			sessionId: "B-session",
			endpointId: "B-endpoint",
			agentId: "B-owner",
		});
		session.settings.set("task.maxConcurrency", 2);
		session.settings.set("task.enableLsp", true);
		const resumed = manager.resumeSubagent(pausedRecord.subagentId, { ownerId: "A-owner" });
		expect(resumed.ok).toBe(true);
		await manager.waitForAll();

		const resumedRun = runs[1];
		expect(resumedRun).toBeDefined();
		expect(resumedRun?.runMode).toBe("resume");
		expect(resumedRun?.cwd).toBe(cwdA);
		expect(resumedRun?.asyncJobManager).toBe(manager);
		expect(resumedRun?.id).toBe(original.id);
		expect(resumedRun?.sessionFile).toBe(original.sessionFile);
		expect(resumedRun?.settings?.get("task.maxConcurrency")).toBe(1);
		expect(resumedRun?.settings?.get("task.enableLsp")).toBe(false);
		expect(resumedRun?.contextFiles?.[0]?.content).toBe("A");
		expect(resumedRun?.workspaceTree?.rendered).toBe("A");
		expect(resumedRun?.inheritedServiceTier).toBe("flex");
		expect(resumedRun?.parentSessionId).toBe("A-session");
		expect(resumedRun?.parentCredentialSessionId).toBe("A-session");
		expect(manager.getSubagentRecords({ ownerId: "A-owner" })).toHaveLength(1);
		expect(manager.getSubagentRecords({ ownerId: "B-owner" })).toHaveLength(0);
	});

	it("captures the original manager and marker before authority checks await", async () => {
		const cwdA = await createCwd("authority-a");
		const cwdB = await createCwd("authority-b");
		const a = createManager();
		const b = createManager();
		const session = createSession(cwdA, a.manager, a.endpointId, "A");
		const markerA = Object.freeze({ kind: "profile", profile: "A" });
		const markerB = Object.freeze({ kind: "profile", profile: "B" });
		session.setModelProfileOwnershipMarker(markerA);
		const runs: ExecutorOptions[] = [];
		const tool = await TaskTool.create(session, {
			runSubprocess: async options => {
				runs.push(options);
				return makeResult(options);
			},
		});
		const admission = startTasks(tool, [task("Authority", "capture before await")]);
		session.moveTo({
			cwd: cwdB,
			manager: b.manager,
			contextFiles: contextFile(cwdB, "B"),
			workspaceTree: createWorkspaceTree(cwdB, "B"),
			serviceTier: "priority",
			sessionId: "B-session",
			endpointId: b.endpointId,
			agentId: "B-owner",
		});
		session.setModelProfileOwnershipMarker(markerB);
		await admission;
		await a.manager.waitForAll();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.cwd).toBe(cwdA);
		expect(runs[0]?.asyncJobManager).toBe(a.manager);
		expect(runs[0]?.parentModelProfileOwnershipMarker).toBe(markerA);
		expect(a.manager.getSubagentRecords({ ownerId: "A-owner" })).toHaveLength(1);
		expect(b.manager.getSubagentRecords({ ownerId: "B-owner" })).toHaveLength(0);
	});
});
