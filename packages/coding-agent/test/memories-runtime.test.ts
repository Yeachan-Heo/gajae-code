import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	getMemoryRoot,
	startMemoryStartupTask,
} from "@gajae-code/coding-agent/memories";
import * as memoryStorage from "@gajae-code/coding-agent/memories/storage";
import { localBackend } from "@gajae-code/coding-agent/memory-backend";
import { getAgentDbPath, Snowflake } from "@gajae-code/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

interface SessionFixture {
	agentDir: string;
	sessionDir: string;
	sessionFile: string;
	settings: Settings;
	session: any;
	modelRegistry: any;
	model: Model;
}

const createdDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	createdDirs.add(dir);
	return dir;
}

function createModel(id = "test-model"): Model {
	return {
		provider: "openai",
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

function createModelRegistry(model: Model): any {
	return {
		find: vi.fn(() => model),
		getAll: vi.fn(() => [model]),
		getApiKey: vi.fn(async () => "test-api-key"),
	};
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<SessionFixture> {
	const agentDir = await makeTempDir("memories-runtime-agent");
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "current-session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);

	const settings = Settings.isolated({
		"memories.enabled": true,
		"memories.minRolloutIdleHours": 0,
		"memories.maxRolloutsPerStartup": 16,
		"memories.threadScanLimit": 64,
		"memories.phase2HeartbeatSeconds": 1,
		...(overrides ?? {}),
	});
	const model = createModel();
	const modelRegistry = createModelRegistry(model);
	const refreshBaseSystemPrompt = vi.fn(async () => undefined);
	const session = {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionDir: () => sessionDir,
			getSessionId: () => "current-thread",
			getCwd: () => agentDir,
		},
		settings,
		taskDepth: 0,
		model,
		modelRegistry,
		refreshBaseSystemPrompt,
	};

	return { agentDir, sessionDir, sessionFile, settings, session, modelRegistry, model };
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(20);
	}
	throw lastError;
}

describe("memories runtime", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		// Prevent getXdgDataPath/getXdgStatePath from resolving to real user data
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.env.XDG_DATA_HOME = savedXdgData;
		process.env.XDG_STATE_HOME = savedXdgState;
		for (const dir of createdDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("startup gating skips when disabled or subagent depth", async () => {
		const disabled = await createFixture({ "memories.enabled": false });
		const openSpy = vi.spyOn(memoryStorage, "openMemoryDb");
		startMemoryStartupTask({
			session: disabled.session,
			settings: disabled.settings,
			modelRegistry: disabled.modelRegistry,
			agentDir: disabled.agentDir,
			taskDepth: 0,
		});
		expect(openSpy).not.toHaveBeenCalled();

		const subagent = await createFixture({ "memories.enabled": true });
		startMemoryStartupTask({
			session: subagent.session,
			settings: subagent.settings,
			modelRegistry: subagent.modelRegistry,
			agentDir: subagent.agentDir,
			taskDepth: 1,
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("startup gating skips when DB is unavailable", async () => {
		const fx = await createFixture();
		vi.spyOn(memoryStorage, "openMemoryDb").mockImplementation(() => {
			throw new Error("db unavailable");
		});
		const stage1Spy = vi.spyOn(ai, "completeSimple");

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await Bun.sleep(50);
		expect(stage1Spy).not.toHaveBeenCalled();
	});

	test("runs phase1 to phase2 and writes consolidated outputs", async () => {
		const fx = await createFixture();
		const rolloutPath = path.join(fx.sessionDir, "thread-a.jsonl");
		const rolloutRows = [
			{ type: "session", id: "thread-a", cwd: fx.agentDir },
			{ type: "message", message: { role: "user", content: "summarize this rollout" } },
		];
		await fs.writeFile(rolloutPath, `${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`);

		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(
				createAssistantMessage(
					JSON.stringify({
						rollout_summary: "Rollout summary A",
						rollout_slug: "thread-a-rollout",
						raw_memory: "Raw memory A",
					}),
				),
			)
			.mockResolvedValueOnce(
				createAssistantMessage(
					JSON.stringify({
						memory_md: "# Memory\n\nConsolidated body",
						memory_summary: "Consolidated summary",
						skills: [{ name: "deploy-playbook", content: "# Deploy\nUse blue/green." }],
					}),
				),
			);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await waitFor(async () => {
			expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe(
				"# Memory\n\nConsolidated body",
			);
			expect((await fs.readFile(path.join(memoryRoot, "memory_summary.md"), "utf8")).trim()).toBe(
				"Consolidated summary",
			);
			expect(
				(await fs.readFile(path.join(memoryRoot, "skills", "deploy-playbook", "SKILL.md"), "utf8")).trim(),
			).toBe("# Deploy\nUse blue/green.");
		});

		await waitFor(() => {
			expect(fx.session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		});
		expect(ai.completeSimple).toHaveBeenCalled();
		expect(ai.completeSimple).toHaveBeenCalledTimes(2);
	});

	test("local backend enqueue starts maintenance immediately for the explicit local selector", async () => {
		const fx = await createFixture({ "memory.backend": "local", "memories.enabled": false });
		const rolloutPath = path.join(fx.sessionDir, "thread-local.jsonl");
		const rolloutRows = [
			{ type: "session", id: "thread-local", cwd: fx.agentDir },
			{ type: "message", message: { role: "user", content: "persist this local memory" } },
		];
		await fs.writeFile(rolloutPath, `${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`);

		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(
				createAssistantMessage(
					JSON.stringify({
						rollout_summary: "Local backend rollout summary",
						rollout_slug: "local-memory",
						raw_memory: "Local backend raw memory",
					}),
				),
			)
			.mockResolvedValueOnce(
				createAssistantMessage(
					JSON.stringify({
						memory_md: "# Memory\n\nLocal backend persisted body",
						memory_summary: "Local backend persisted summary",
						skills: [],
					}),
				),
			);

		await localBackend.enqueue(fx.agentDir, fx.session.sessionManager.getCwd(), fx.session);

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		expect(fx.settings.getCwd()).not.toBe(fx.session.sessionManager.getCwd());
		await waitFor(async () => {
			expect((await fs.readFile(path.join(memoryRoot, "memory_summary.md"), "utf8")).trim()).toBe(
				"Local backend persisted summary",
			);
			const payload = await localBackend.buildDeveloperInstructions(fx.agentDir, fx.settings, fx.session);
			expect(payload).toContain("Local backend persisted summary");
			expect(payload).toContain("memory://root/memory_summary.md");
			expect(payload).not.toContain(memoryRoot);
		});

		expect(ai.completeSimple).toHaveBeenCalledTimes(2);
		await waitFor(() => {
			expect(fx.session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		});
	});

	test("local backend enqueue keeps subagent sessions from starting local maintenance", async () => {
		const fx = await createFixture({ "memory.backend": "local" });
		fx.session.taskDepth = 1;
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");

		await localBackend.enqueue(fx.agentDir, fx.session.sessionManager.getCwd(), fx.session);
		await Bun.sleep(50);

		expect(completeSimpleSpy).not.toHaveBeenCalled();
		expect(fx.session.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("phase2 sync prunes stale summaries and preserves raw memory ordering", async () => {
		const fx = await createFixture();
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			createAssistantMessage(
				JSON.stringify({
					memory_md: "# Memory\n\nMerged",
					memory_summary: "Merged summary",
					skills: [{ name: "ops", content: "# Ops\nRunbook" }],
				}),
			),
		);

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.upsertThreads(db, [
			{
				id: "thread-a",
				updatedAt: 100,
				rolloutPath: "/tmp/a.jsonl",
				cwd: fx.session.sessionManager.getCwd(),
				sourceKind: "cli",
			},
			{
				id: "thread-b",
				updatedAt: 200,
				rolloutPath: "/tmp/b.jsonl",
				cwd: fx.session.sessionManager.getCwd(),
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-a", 100, "raw-a", "summary-a", "alpha", 100);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-b", 200, "raw-b", "summary-b", "beta", 200);
		memoryStorage.enqueueGlobalWatermark(db, 200, fx.session.sessionManager.getCwd(), {
			forceDirtyWhenNotAdvanced: true,
		});
		memoryStorage.closeMemoryDb(db);

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await fs.mkdir(path.join(memoryRoot, "rollout_summaries"), { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "rollout_summaries", "old.md"), "stale");

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(async () => {
			const files = await fs.readdir(path.join(memoryRoot, "rollout_summaries"));
			expect(files.includes("old.md")).toBe(false);
			expect(files).toEqual(expect.arrayContaining(["thread-a-alpha.md", "thread-b-beta.md"]));
			const raw = await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8");
			expect(raw.indexOf("## thread-b")).toBeLessThan(raw.indexOf("## thread-a"));
		});
	});

	test("phase2 empty-input cleanup removes consolidated files and skills dir", async () => {
		const fx = await createFixture();
		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await fs.mkdir(path.join(memoryRoot, "skills", "legacy"), { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "MEMORY.md"), "legacy memory");
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "legacy summary");
		await fs.writeFile(path.join(memoryRoot, "skills", "legacy", "SKILL.md"), "legacy skill");

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.enqueueGlobalWatermark(db, 300, fx.session.sessionManager.getCwd(), {
			forceDirtyWhenNotAdvanced: true,
		});
		memoryStorage.closeMemoryDb(db);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(async () => {
			expect(await Bun.file(path.join(memoryRoot, "MEMORY.md")).exists()).toBe(false);
			expect(await Bun.file(path.join(memoryRoot, "memory_summary.md")).exists()).toBe(false);
			expect(await Bun.file(path.join(memoryRoot, "skills")).exists()).toBe(false);
			expect((await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8")).trim()).toBe(
				"# Raw Memories\n\nNo raw memories yet.",
			);
		});
	});
});

describe("buildMemoryToolDeveloperInstructions", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.env.XDG_DATA_HOME = savedXdgData;
		process.env.XDG_STATE_HOME = savedXdgState;
		for (const dir of createdDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("returns undefined for missing or empty summaries", async () => {
		const agentDir = await makeTempDir("memories-runtime-instructions");
		const settings = Settings.isolated({ "memory.backend": "local" });

		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings)).toBeUndefined();

		const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "   \n\t\n");
		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings)).toBeUndefined();
	});

	test("renders payload with truncation for non-empty summary", async () => {
		const agentDir = await makeTempDir("memories-runtime-instructions");
		const settings = Settings.isolated({
			"memory.backend": "local",
			"memories.summaryInjectionTokenLimit": 8,
		});
		const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(
			path.join(memoryRoot, "memory_summary.md"),
			`${"A".repeat(120)}\n${"B".repeat(120)}\n${"C".repeat(120)}`,
		);

		const payload = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(payload).toBeDefined();
		expect(payload).toContain("memory://root/memory_summary.md");
		expect(payload).not.toContain(memoryRoot);
		expect(payload).toContain("...[truncated]...");
	});
});
