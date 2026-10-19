import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Context, registerCustomApi, unregisterCustomApis } from "@gajae-code/ai/core";
import { createMockModel, type MockCall, type MockResponse } from "@gajae-code/ai/providers/mock";
import { logger } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { TaskParams } from "../src/task/types";

const PROVIDER = "sdk-task-move-fixture";
const MODEL_ID = "task-move-child";
const SOURCE_ID = "sdk-task-move-execution-test";
const LABELS = ["A-first", "A-queued", "B-new", "A-pause"] as const;
type TaskLabel = (typeof LABELS)[number];

function bashCall(label: string): MockResponse {
	return {
		content: [
			{
				type: "toolCall",
				id: `${label}-bash`,
				name: "bash",
				arguments: {
					command: `cat sentinel.txt > ${label}.out; pwd > ${label}.cwd`,
					timeout: 15,
				},
			},
		],
		stopReason: "toolUse",
	};
}

function yieldCall(label: string): MockResponse {
	return {
		content: [
			{
				type: "toolCall",
				id: `${label}-yield`,
				name: "yield",
				arguments: { result: { data: { completed: true, task: label } } },
			},
		],
		stopReason: "toolUse",
	};
}

function stopReply(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function assignmentLabel(context: Context): TaskLabel | undefined {
	for (const message of context.messages.toReversed()) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		const label = LABELS.find(candidate => text.includes(`${candidate}: use bash to read sentinel.txt`));
		if (label) return label;
	}
	return undefined;
}

function task(label: TaskLabel) {
	return {
		id: label,
		description: label,
		assignment: `${label}: use bash to read sentinel.txt in the current working directory, then report its contents.`,
	};
}

interface Harness {
	root: string;
	cwdA: string;
	cwdB: string;
	session: AgentSession;
	manager: AsyncJobManager;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	calls: MockCall[];
	updates: unknown[];
	dispose(): Promise<void>;
}

async function createHarness(handler: (context: Context) => Promise<MockResponse>): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-task-move-execution-"));
	const cwdA = path.join(root, "workspace-a");
	const cwdB = path.join(cwdA, "workspace-b");
	const provider = `${PROVIDER}-${path.basename(root).toLowerCase()}`;
	const sourceId = `${SOURCE_ID}:${path.basename(root)}`;
	const api = `${SOURCE_ID}-${path.basename(root)}`;
	await fs.mkdir(cwdB, { recursive: true });
	await Promise.all([
		Bun.write(path.join(cwdA, "sentinel.txt"), "sentinel-A\n"),
		Bun.write(path.join(cwdB, "sentinel.txt"), "sentinel-B\n"),
	]);

	const settings = Settings.isolated({
		"async.enabled": true,
		"task.maxConcurrency": 1,
		"task.enableLsp": false,
		"task.agentModelOverrides": { executor: `${provider}/${MODEL_ID}` },
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
	});
	const authStorage = await AuthStorage.create(path.join(root, "testauth.db"));
	authStorage.setRuntimeApiKey(provider, "test-only-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"), settings);
	const mock = createMockModel({ id: MODEL_ID, provider, handler });
	Object.defineProperty(mock.model, "api", { value: api });
	registerCustomApi(api, mock.stream, sourceId);
	modelRegistry.registerProvider(provider, {
		api,
		apiKey: "test-only-key",
		baseUrl: "https://sdk-task-move.invalid/v1",
		models: [
			{
				id: MODEL_ID,
				name: MODEL_ID,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
				maxTokens: 4_096,
			},
		],
	});
	const model = modelRegistry.find(provider, MODEL_ID);
	if (!model) throw new Error("Expected the isolated SDK Task test model");

	let session: Harness["session"] | undefined;
	try {
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, root));
		sessionManager.appendMessage({ role: "user", content: "session move execution fixture", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		({ session } = await createAgentSession({
			cwd: cwdA,
			agentDir: root,
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
			toolNames: ["task", "move_session", "read"],
		}));
		if (
			!modelRegistry.getAvailable().some(candidate => candidate.provider === provider && candidate.id === MODEL_ID)
		) {
			throw new Error(
				`Fixture model unavailable after SDK construction: catalog=${modelRegistry.getAll().some(candidate => candidate.provider === provider)}, auth=${authStorage.hasAuth(provider)}`,
			);
		}
		const manager = AsyncJobManager.forEndpoint(session.sessionManager.getSessionId());
		if (!manager) throw new Error("Expected the SDK-owned AsyncJobManager for this session endpoint");
		return {
			root,
			cwdA,
			cwdB,
			session,
			manager,
			modelRegistry,
			authStorage,
			calls: mock.calls,
			updates: [],
			dispose: async () => {
				await session?.dispose();
				unregisterCustomApis(sourceId);
				await modelRegistry.dispose();
				authStorage.close();
				await fs.rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await session?.dispose();
		unregisterCustomApis(sourceId);
		await modelRegistry.dispose();
		authStorage.close();
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	}
}

async function admit(harness: Harness, callId: string, tasks: TaskParams["tasks"]) {
	const tool = harness.session.getToolForExecution("task");
	if (!tool) throw new Error("Expected a guarded public SDK Task tool");
	const result = await tool.execute(callId, { agent: "executor", tasks }, undefined, update =>
		harness.updates.push(update.details),
	);
	if (!result.details?.async?.jobId) throw new Error("Expected Task admission to create an async job");
	return result.details.async.jobId;
}

async function awaitExecutionBoundary(harness: Harness, jobId: string, boundary: Promise<void>): Promise<void> {
	const job = harness.manager.getJob(jobId);
	if (!job) throw new Error("Expected the admitted job");
	await Promise.race([
		boundary,
		job.promise.then(() => {
			throw new Error(
				`Task finished before the expected execution boundary: ${JSON.stringify(harness.manager.getJob(jobId))}`,
			);
		}),
	]);
}

function recordFor(manager: AsyncJobManager, label: TaskLabel) {
	return manager.getSubagentRecords().find(record => record.subagentId.endsWith(label));
}

describe("public SDK Task execution retains its admitted workspace across move", () => {
	for (const movePath of ["manager", "move_session"] as const) {
		it(`keeps active and queued A tasks in A after ${movePath} while new work runs from B`, async () => {
			const errors: string[] = [];
			const originalError = logger.error.bind(logger);
			const errorSpy = vi.spyOn(logger, "error").mockImplementation((message, ...args) => {
				if (errors.length < 16)
					errors.push(
						JSON.stringify({ message, args }, (_key, value) =>
							value instanceof Error ? { message: value.message, stack: value.stack } : value,
						),
					);
				originalError(message, ...args);
			});
			const firstAfterBash = Promise.withResolvers<void>();
			const releaseFirst = Promise.withResolvers<void>();
			const counts = new Map<TaskLabel, number>();
			let harness: Harness | undefined;
			try {
				harness = await createHarness(async context => {
					const label = assignmentLabel(context);
					if (!label) return stopReply("Parent notification received.");
					const turn = (counts.get(label) ?? 0) + 1;
					counts.set(label, turn);
					if (turn === 1) return bashCall(label);
					if (label === "A-first" && turn === 2) {
						firstAfterBash.resolve();
						await releaseFirst.promise;
					}
					return yieldCall(label);
				});

				const aJob = await admit(harness, "admit-a-batch", [task("A-first"), task("A-queued")]);
				await awaitExecutionBoundary(harness, aJob, firstAfterBash.promise);
				expect(counts.get("A-queued") ?? 0).toBe(0);
				expect(await fs.readFile(path.join(harness.cwdA, "A-first.out"), "utf8")).toBe("sentinel-A\n");
				expect(await fs.readFile(path.join(harness.cwdA, "A-first.cwd"), "utf8")).toBe(`${harness.cwdA}\n`);

				const sessionId = harness.session.sessionManager.getSessionId();
				if (movePath === "manager") await harness.session.sessionManager.moveTo(harness.cwdB);
				else {
					const move = harness.session.getToolForExecution("move_session");
					if (!move) throw new Error("Expected public move_session");
					await move.execute("move-with-pending-tasks", { path: "workspace-b" });
				}
				expect(harness.session.sessionManager.getCwd()).toBe(harness.cwdB);
				const bJob = await admit(harness, "admit-b-new", [task("B-new")]);
				await harness.manager.getJob(bJob)?.promise;
				if (!(await Bun.file(path.join(harness.cwdB, "B-new.out")).exists())) {
					throw new Error(
						`Moved child bash did not produce output: ${JSON.stringify(harness.calls.flatMap(call => call.context.messages.filter(message => message.role === "toolResult")))}`,
					);
				}
				expect(await Bun.file(path.join(harness.cwdB, "B-new.out")).text()).toBe("sentinel-B\n");
				expect(await Bun.file(path.join(harness.cwdB, "B-new.cwd")).text()).toBe(`${harness.cwdB}\n`);

				releaseFirst.resolve();
				await harness.manager.waitForAll();
				expect(harness.session.sessionManager.getSessionId()).toBe(sessionId);
				for (const label of ["A-first", "A-queued"] as const) {
					const completed = recordFor(harness.manager, label);
					if (completed?.status !== "completed") {
						const store = harness.session.sessionManager.getArtifactManager()?.getManagedStore();
						const selector = completed ? store?.readExpected(`${completed.subagentId}.md.selector.json`) : null;
						const selected = selector
							? (JSON.parse(Buffer.from(selector.bytes).toString("utf8")) as { outputFilename: string })
							: undefined;
						const output = selected ? store?.readExpected(selected.outputFilename) : null;
						throw new Error(
							`Task ${label} did not complete after relocation: ${output ? Buffer.from(output.bytes).toString("utf8") : "no recorded output"}; errors=${JSON.stringify(errors)}`,
						);
					}
					expect(recordFor(harness.manager, label)?.status).toBe("completed");
					const read = harness.session.getToolByName("read");
					if (!read) throw new Error("Expected guarded SDK read tool");
					const persisted = await read.execute(`read-${label}`, { path: `agent://${completed.subagentId}` });
					const text = persisted.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					expect(text).toContain('"completed"');
					expect(text).toContain("true");
					expect(text).toContain(label);
					if (!(await Bun.file(path.join(harness.cwdA, `${label}.out`)).exists())) {
						const record = recordFor(harness.manager, label);
						throw new Error(
							`Missing ${label} execution output: ${JSON.stringify(record?.currentJobId ? harness.manager.getJob(record.currentJobId) : record)}`,
						);
					}
					expect(await Bun.file(path.join(harness.cwdA, `${label}.out`)).text()).toBe("sentinel-A\n");
					expect(await Bun.file(path.join(harness.cwdA, `${label}.cwd`)).text()).toBe(`${harness.cwdA}\n`);
				}
			} finally {
				releaseFirst.resolve();
				try {
					await harness?.dispose();
				} finally {
					errorSpy.mockRestore();
				}
			}
		}, 60_000);
	}

	it("resumes the same paused child from A after the parent moves to B", async () => {
		const pauseBoundary = Promise.withResolvers<void>();
		const releasePause = Promise.withResolvers<void>();
		const counts = new Map<TaskLabel, number>();
		let harness: Harness | undefined;
		try {
			harness = await createHarness(async context => {
				const label = assignmentLabel(context);
				if (!label) return stopReply("Parent notification received.");
				if (label !== "A-pause") throw new Error("Unexpected Task assignment in pause/resume case");
				const turn = (counts.get(label) ?? 0) + 1;
				counts.set(label, turn);
				if (turn === 1) return bashCall(label);
				if (turn === 2) {
					pauseBoundary.resolve();
					await releasePause.promise;
					return stopReply("Pause at this safe boundary.");
				}
				if (turn === 3) return bashCall("A-pause-resumed");
				return yieldCall(label);
			});

			const job = await admit(harness, "admit-a-pausable", [task("A-pause")]);
			await awaitExecutionBoundary(harness, job, pauseBoundary.promise);
			expect(await fs.readFile(path.join(harness.cwdA, "A-pause.out"), "utf8")).toBe("sentinel-A\n");
			const running = recordFor(harness.manager, "A-pause");
			if (!running) throw new Error("Expected the real child AgentSession subagent record");
			const pause = harness.manager.pauseSubagent(running.subagentId, { ownerId: running.ownerId });
			expect(pause.ok).toBe(true);
			releasePause.resolve();
			await harness.manager.waitForAll();

			const paused = recordFor(harness.manager, "A-pause");
			if (!paused) throw new Error("Expected the paused child record to be retained");
			expect(paused.status).toBe("paused");
			const originalId = paused.subagentId;
			const originalFile = paused.sessionFile;
			const artifacts = harness.session.sessionManager.getArtifactManager();
			if (!artifacts?.getManagedStore()) throw new Error("Expected real managed child transcript storage");
			const transcript = path.join(artifacts.dir, `${originalId}.jsonl`);
			expect(await Bun.file(transcript).exists()).toBe(true);

			const parentSessionId = harness.session.sessionManager.getSessionId();
			await harness.session.sessionManager.moveTo(harness.cwdB);
			expect(harness.session.sessionManager.getCwd()).toBe(harness.cwdB);
			expect(harness.session.sessionManager.getSessionId()).toBe(parentSessionId);
			const resumed = harness.manager.resumeSubagent(originalId, { ownerId: paused.ownerId });
			expect(resumed.ok).toBe(true);
			await harness.manager.waitForAll();

			const completed = recordFor(harness.manager, "A-pause");
			expect(completed?.subagentId).toBe(originalId);
			expect(completed?.sessionFile).toBe(originalFile);
			expect(completed?.status).toBe("completed");
			expect(await Bun.file(path.join(harness.cwdA, "A-pause-resumed.out")).text()).toBe("sentinel-A\n");
			expect(await Bun.file(path.join(harness.cwdA, "A-pause-resumed.cwd")).text()).toBe(`${harness.cwdA}\n`);
		} finally {
			releasePause.resolve();
			await harness?.dispose();
		}
	}, 60_000);
});
