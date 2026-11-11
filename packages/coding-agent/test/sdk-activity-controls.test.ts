import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager, type SubagentRecord, type SubagentRunOutcome } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import { MCPManager } from "../src/runtime-mcp/manager";
import {
	ACTIVITY_CONTROL_LIMITS,
	ActivityControls,
	isActivityControlOperation,
	isActivityControlQueryOperation,
} from "../src/sdk/activity-controls";
import { JobObservation } from "../src/sdk/job-observation";
import { createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { CronTool, resetCronRegistryForTests } from "../src/tools/cron";
import type { ToolSession } from "../src/tools/index";

const cleanups: Array<() => Promise<void>> = [];

async function fixture(mcpManager?: MCPManager, isolatedJobs = false) {
	const temp = TempDir.createSync("@sdk-activity-controls-");
	const prior = AsyncJobManager.instance();
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	const settings = Settings.isolated({ "bash.autoBackground.enabled": false });
	const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
	const owner = `activity-owner-${crypto.randomUUID()}`;
	const factoryResult = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.path(),
		authStorage: auth,
		modelRegistry: registry,
		settings,
		agentId: owner,
		agentRegistry: new AgentRegistry(),
		sessionManager: SessionManager.inMemory(temp.path()),
		disableExtensionDiscovery: true,
		extensions: [],
		toolNames: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMCP: mcpManager !== undefined,
		mcpManager,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
	});
	// A trusted facade fixture can settle deliveries without the factory's prompt
	// queue retaining claims. Its larger admission budget also lets snapshot-bound
	// tests exceed the view limit without depending on the factory's hard cap.
	const isolatedManager = isolatedJobs
		? new AsyncJobManager({
				onJobComplete: () => {},
				maxRunningJobs: ACTIVITY_CONTROL_LIMITS.entries + 1,
			})
		: undefined;
	const manager = isolatedManager ?? AsyncJobManager.forEndpoint(factoryResult.session.sessionId);
	if (!manager || !factoryResult.jobObservation) throw new Error("Factory did not provide owned job observation");
	const observation = isolatedManager ? new JobObservation(isolatedManager, owner) : undefined;
	const result = observation ? { ...factoryResult, jobObservation: observation } : factoryResult;
	const controls = new ActivityControls(result);
	cleanups.push(async () => {
		controls.dispose();
		try {
			await result.session.dispose();
		} finally {
			observation?.dispose();
			await isolatedManager?.dispose();
			AsyncJobManager.setInstance(prior);
			await registry.dispose();
			await settings.close();
			auth.close();
			await temp.remove();
		}
	});
	return { result, controls, manager, owner };
}

function monitor(manager: AsyncJobManager, ownerId: string, label = "monitor", id?: string) {
	const jobId = manager.register(
		"bash",
		label,
		({ signal }) => {
			const gate = Promise.withResolvers<string>();
			if (signal.aborted) gate.resolve("cancelled");
			else signal.addEventListener("abort", () => gate.resolve("cancelled"), { once: true });
			return gate.promise;
		},
		{ ownerId, id, metadata: { monitor: true } },
	);
	return manager.getJob(jobId)!;
}

function pausedTask(manager: AsyncJobManager, ownerId: string, id: string): SubagentRecord {
	const record: SubagentRecord = {
		subagentId: id,
		ownerId,
		status: "paused",
		currentJobId: null,
		historicalJobIds: [],
		sessionFile: "/private/task.jsonl",
		resumable: true,
	};
	manager.registerSubagentRecord(record);
	return record;
}

async function cron(owner: string) {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => "activity-test-session",
		getAgentId: () => owner,
		sendCustomMessage: async () => {},
		allocateOutputArtifact: async () => ({}),
	} as unknown as ToolSession;
	return new CronTool(session).execute("activity-cron", {
		op: "create",
		cron_expression: "*/5 * * * *",
		prompt: "owned reminder",
		recurring: true,
	});
}

async function mcpFixture() {
	let initializations = 0;
	let deletes = 0;
	let pendingDelete: { entered: () => void; release: Promise<void> } | undefined;
	const releases: Array<() => void> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				deletes++;
				const pending = pendingDelete;
				pendingDelete = undefined;
				if (pending) {
					pending.entered();
					await pending.release;
				}
				return new Response(null, { status: 204 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as { id?: number; method: string };
			if (body.id === undefined) return new Response(null, { status: 202 });
			if (body.method === "initialize") {
				initializations++;
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "fixture", version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": `activity-${initializations}` } },
				);
			}
			if (body.method === "tools/list")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: [{ name: "ping", description: "fixture", inputSchema: { type: "object", properties: {} } }],
					},
				});
			return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } });
		},
	});
	const manager = new MCPManager(process.cwd());
	cleanups.push(async () => {
		for (const release of releases) release();
		await manager.disconnectAll();
		server.stop(true);
	});
	await manager.connectServers(
		{
			alpha: {
				type: "http",
				protocol: "legacy",
				url: server.url.href,
				timeout: 1_000,
				headers: { Authorization: "Bearer fixture-private-secret" },
			},
		},
		{},
	);
	const f = await fixture(manager);
	return {
		...f,
		mcp: manager,
		initializes: () => initializations,
		deletes: () => deletes,
		blockDelete() {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			releases.push(() => release.resolve());
			pendingDelete = { entered: () => entered.resolve(), release: release.promise };
			return { entered: entered.promise, release: () => release.resolve() };
		},
	};
}

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	resetCronRegistryForTests();
});

describe("session-owned SDK activity controls", () => {
	test("closed operation guards distinguish queries and reject generic manager passthrough", async () => {
		expect(isActivityControlOperation("activity.cancel")).toBe(true);
		expect(isActivityControlOperation("mcp.reconnect")).toBe(true);
		expect(isActivityControlOperation("mcp.disconnectAll")).toBe(false);
		expect(isActivityControlOperation("activity.control")).toBe(false);
		expect(isActivityControlQueryOperation("activity.detail")).toBe(true);
		expect(isActivityControlQueryOperation("activity.cancel")).toBe(false);
		const f = await fixture();
		await expect(f.controls.control("activity.snapshot", { ownerId: "foreign" })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(f.controls.control("activity.cancel", { ref: "guessed", manager: f.manager })).rejects.toMatchObject(
			{ code: "invalid_input" },
		);
	});

	test("real facade observations are owner scoped; opaque references never authorize another service", async () => {
		const f = await fixture();
		const owned = monitor(f.manager, f.owner);
		const foreign = monitor(f.manager, "foreign");
		f.manager.appendOutput(owned.id, "owned output");
		f.manager.appendOutput(foreign.id, "private foreign output");
		const sibling = new ActivityControls(f.result);
		try {
			const snapshot = f.controls.getActivitySnapshot();
			expect(snapshot.jobs).toHaveLength(1);
			expect(snapshot.jobs[0]).toMatchObject({ kind: "job", controls: ["cancel"], readable: true });
			expect(snapshot.jobs[0]!.ref).not.toBe(owned.id);
			expect(f.controls.getDetail({ ref: snapshot.jobs[0]!.ref }).output).toBe("owned output");
			expect(() => sibling.operateActivity({ ref: snapshot.jobs[0]!.ref }, "cancel")).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
			expect(() => f.controls.operateActivity({ ref: foreign.id }, "cancel")).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
			f.controls.operateActivity({ ref: snapshot.jobs[0]!.ref }, "cancel");
			expect(owned.abortController.signal.aborted).toBe(true);
			expect(foreign.abortController.signal.aborted).toBe(false);
		} finally {
			sibling.dispose();
		}
	});

	test("ordinary/folded jobs remain read-only, retained terminal monitors readable but not cancellable", async () => {
		const f = await fixture(undefined, true);
		const folded = monitor(f.manager, f.owner, "folded");
		f.manager.markBackgrounded(folded.id, folded.generation, "sdk_control");
		const ordinary = f.manager.register(
			"bash",
			"ordinary",
			({ signal }) => {
				const done = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
				return done.promise;
			},
			{ ownerId: f.owner },
		);
		const gate = Promise.withResolvers<string>();
		const terminal = f.manager.register("bash", "terminal", () => gate.promise, {
			ownerId: f.owner,
			metadata: { monitor: true },
		});
		f.manager.appendOutput(terminal, "terminal output");
		gate.resolve("done");
		await f.manager.getJob(terminal)!.promise;
		expect(await f.manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
		const snapshot = f.controls.getActivitySnapshot();
		for (const label of ["ordinary", "folded"]) {
			const entry = snapshot.jobs.find(row => row.label === label)!;
			expect(entry).toMatchObject({ controls: [], readable: false });
			expect(f.controls.getDetail({ ref: entry.ref }).output).toBeUndefined();
			expect(() => f.controls.operateActivity({ ref: entry.ref }, "cancel")).toThrow(
				expect.objectContaining({ code: "read_only" }),
			);
		}
		const entry = snapshot.jobs.find(row => row.label === "terminal")!;
		expect(f.controls.getDetail({ ref: entry.ref }).output).toBe("terminal output");
		expect(() => f.controls.operateActivity({ ref: entry.ref }, "cancel")).toThrow(
			expect.objectContaining({ code: "already_terminal" }),
		);
		expect(f.manager.getJob(ordinary)?.status).toBe("running");
	});

	test("real task pause/resume/cancel retains cooperative semantics and captured runner", async () => {
		const f = await fixture();
		const gate = Promise.withResolvers<SubagentRunOutcome>();
		const jobId = f.manager.register("task", "owned task", () => gate.promise, { ownerId: f.owner });
		const record = pausedTask(f.manager, f.owner, "owned-task");
		record.status = "running";
		record.currentJobId = jobId;
		f.manager.registerSubagentRecord(record);
		let pauses = 0;
		f.manager.registerLiveHandle("owned-task", {
			requestPause: () => {
				pauses++;
			},
			injectMessage: async () => {},
		});
		const messages: Array<string | undefined> = [];
		f.manager.registerResumeDescriptor({ subagentId: "owned-task", ownerId: f.owner, data: {} }, (id, message) => {
			messages.push(message);
			return f.manager.register(
				"task",
				id,
				({ signal }) => {
					const done = Promise.withResolvers<string>();
					signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
					return done.promise;
				},
				{ ownerId: f.owner },
			);
		});
		const running = f.controls.getActivitySnapshot().tasks[0]!;
		expect(running.controls).toEqual(["cancel", "pause"]);
		expect(f.controls.operateActivity({ ref: running.ref }, "pause")).toEqual({ status: "running" });
		expect(pauses).toBe(1);
		expect(f.manager.getJob(jobId)!.abortController.signal.aborted).toBe(false);
		gate.resolve({ kind: "paused", note: "safe boundary" });
		await f.manager.getJob(jobId)!.promise;
		const paused = f.controls.getActivitySnapshot().tasks[0]!;
		expect(paused.controls).toEqual(["cancel", "resume"]);
		expect(f.controls.operateActivity({ ref: paused.ref, message: "continue" }, "resume")).toMatchObject({
			status: "running",
			queued: false,
		});
		expect(messages).toEqual(["continue"]);
		expect(() => f.controls.operateActivity({ ref: paused.ref }, "cancel")).toThrow(
			expect.objectContaining({ code: "stale_generation" }),
		);
		const resumed = f.controls.getActivitySnapshot().tasks[0]!;
		f.controls.operateActivity({ ref: resumed.ref }, "cancel");
		expect(f.manager.getSubagentRecord(record.subagentId)?.status).toBe("cancelled");
	});

	test("task replacement is rejected at resolution and a missing runner is never a fake resume", async () => {
		const f = await fixture();
		pausedTask(f.manager, f.owner, "retained");
		const old = f.controls.getActivitySnapshot().tasks[0]!;
		pausedTask(f.manager, f.owner, "retained");
		expect(() => f.controls.operateActivity({ ref: old.ref }, "cancel")).toThrow(
			expect.objectContaining({ code: "stale_generation" }),
		);
		const current = f.controls.getActivitySnapshot().tasks[0]!;
		expect(current.controls).toEqual(["cancel"]);
		expect(() => f.controls.operateActivity({ ref: current.ref }, "resume")).toThrow(
			expect.objectContaining({ code: "no_runner" }),
		);
		expect(() => f.controls.operateActivity({ ref: current.ref }, "delete")).toThrow(
			expect.objectContaining({ code: "unsupported" }),
		);
	});

	test("queued tasks can be cancelled while terminal task cancellation is rejected", async () => {
		const f = await fixture();
		const queued = pausedTask(f.manager, f.owner, "queued");
		queued.status = "queued";
		queued.queued = { ownerId: f.owner, seq: 1, message: "private queued input", createdAt: Date.now() };
		f.manager.registerSubagentRecord(queued);
		const completed = pausedTask(f.manager, f.owner, "completed");
		completed.status = "completed";
		f.manager.registerSubagentRecord(completed);
		const snapshot = f.controls.getActivitySnapshot();
		expect(JSON.stringify(snapshot)).not.toContain("private queued input");
		const queueRow = snapshot.tasks.find(row => row.label === "queued")!;
		const terminalRow = snapshot.tasks.find(row => row.label === "completed")!;
		expect(queueRow.controls).toEqual(["cancel"]);
		expect(terminalRow.controls).toEqual([]);
		expect(() => f.controls.operateActivity({ ref: queueRow.ref }, "resume")).toThrow(
			expect.objectContaining({ code: "already_queued" }),
		);
		expect(() => f.controls.operateActivity({ ref: terminalRow.ref }, "cancel")).toThrow(
			expect.objectContaining({ code: "already_terminal" }),
		);
		expect(f.controls.operateActivity({ ref: queueRow.ref }, "cancel")).toEqual({ cancelled: true });
		expect(f.manager.getSubagentRecord(queued.subagentId)?.status).toBe("cancelled");
	});

	test("facade CAS rejects replacement and foreign-owner races after a snapshot was read", async () => {
		const f = await fixture();
		const view = f.result.jobObservation!;
		for (const race of ["replacement", "owner"] as const) {
			const record = pausedTask(f.manager, f.owner, `raced-${race}`);
			const entry = f.controls.getActivitySnapshot().tasks.find(row => row.label === record.subagentId)!;
			const getSnapshot = view.getSnapshot.bind(view);
			const snapshotRead = spyOn(view, "getSnapshot").mockImplementationOnce(() => {
				const snapshot = getSnapshot();
				if (race === "replacement") pausedTask(f.manager, f.owner, record.subagentId);
				else record.ownerId = "foreign";
				return snapshot;
			});
			try {
				expect(() => f.controls.operateActivity({ ref: entry.ref }, "cancel")).toThrow(
					expect.objectContaining({ code: race === "replacement" ? "stale_generation" : "not_found" }),
				);
			} finally {
				snapshotRead.mockRestore();
			}
			expect(f.manager.getSubagentRecord(record.subagentId)?.status).toBe("paused");
		}
	});

	test("cron deletion uses real owner-bound schedule identity; pause/resume are unsupported", async () => {
		const f = await fixture();
		await cron(f.owner);
		await cron("foreign");
		const snapshot = f.controls.getActivitySnapshot();
		expect(snapshot.crons).toHaveLength(1);
		const entry = snapshot.crons[0]!;
		expect(entry).toMatchObject({
			controls: ["delete"],
			cronExpression: "*/5 * * * *",
			prompt: "owned reminder",
			recurring: true,
		});
		expect(() => f.controls.operateActivity({ ref: entry.ref }, "pause")).toThrow(
			expect.objectContaining({ code: "unsupported" }),
		);
		expect(f.controls.operateActivity({ ref: entry.ref }, "delete")).toEqual({ deleted: true });
		expect(f.controls.getActivitySnapshot().crons).toEqual([]);
		expect(() => f.controls.operateActivity({ ref: entry.ref }, "delete")).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
	});

	test("ack is scoped to the latest snapshot and clears only the existing failure latch", async () => {
		const f = await fixture();
		const gate = Promise.withResolvers<string>();
		const job = f.manager.register("bash", "failed", () => gate.promise, {
			ownerId: f.owner,
			metadata: { monitor: true },
		});
		gate.reject(new Error("fixture failure"));
		await f.manager.getJob(job)!.promise;
		const first = f.controls.getActivitySnapshot();
		expect(first.failedUnacknowledged).toBe(true);
		const second = f.controls.getActivitySnapshot();
		expect(() => f.controls.acknowledge({ ref: first.ref })).toThrow(expect.objectContaining({ code: "not_found" }));
		expect(() => f.controls.acknowledge({ ref: second.jobs[0]!.ref })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(f.controls.acknowledge({ ref: second.ref })).toEqual({ acknowledged: true });
		expect(f.controls.getActivitySnapshot().failedUnacknowledged).toBe(false);
		expect(f.manager.getJob(job)?.status).toBe("failed");
	});

	test("references and payloads are bounded, detached, and pruned; no accessors run at request parsing", async () => {
		const f = await fixture(undefined, true);
		for (let index = 0; index <= ACTIVITY_CONTROL_LIMITS.entries; index++) {
			monitor(f.manager, f.owner, `job-${index}-${"x".repeat(ACTIVITY_CONTROL_LIMITS.fieldChars)}`);
		}
		const first = f.controls.getActivitySnapshot();
		expect(first.jobs).toHaveLength(ACTIVITY_CONTROL_LIMITS.entries);
		expect(first.truncated.jobs).toBe(true);
		expect(first.jobs.every(row => row.label.length <= ACTIVITY_CONTROL_LIMITS.fieldChars)).toBe(true);
		const ref = first.jobs[0]!.ref;
		first.jobs[0]!.controls.length = 0;
		expect(f.controls.getActivitySnapshot().jobs[0]!.controls).toEqual(["cancel"]);
		const job = f.manager.getJobsSnapshot({ ownerId: f.owner }).jobs[0]!;
		f.manager.appendOutput(job.id, "o".repeat(ACTIVITY_CONTROL_LIMITS.outputChars + 1));
		expect(f.controls.getDetail({ ref })).toMatchObject({
			outputTruncated: true,
			output: "o".repeat(ACTIVITY_CONTROL_LIMITS.outputChars),
		});
		let reads = 0;
		expect(() =>
			f.controls.operateActivity(
				{
					get ref() {
						reads++;
						return ref;
					},
				},
				"cancel",
			),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(reads).toBe(0);
		expect(() => f.controls.operateActivity({ ref, ownerId: "foreign" }, "cancel")).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() =>
			f.controls.operateActivity({ ref, message: "m".repeat(ACTIVITY_CONTROL_LIMITS.messageChars + 1) }, "resume"),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		const view = f.result.jobObservation!;
		const original = view.getSnapshot();
		const read = spyOn(view, "getSnapshot").mockReturnValue({ ...original, jobs: [] });
		try {
			expect(f.controls.getActivitySnapshot().jobs).toEqual([]);
		} finally {
			read.mockRestore();
		}
		expect(() => f.controls.getDetail({ ref })).toThrow(expect.objectContaining({ code: "not_found" }));
	});

	test("folded evidence supplied by the facade remains observable without a retained backend job", async () => {
		const f = await fixture();
		const view = f.result.jobObservation!;
		const snapshot = view.getSnapshot();
		const getSnapshot = spyOn(view, "getSnapshot").mockReturnValue({
			...snapshot,
			jobs: [],
			foldedJobs: [
				{
					id: "evicted",
					generation: "retained-generation",
					kind: "bash",
					label: "retained failure",
					status: "failed",
					backgrounded: true,
					deliveryState: "failed-visible",
				},
			],
		});
		try {
			const row = f.controls.getActivitySnapshot().jobs[0]!;
			expect(row).toMatchObject({
				label: "retained failure",
				readable: false,
				controls: [],
				deliveryState: "failed-visible",
			});
			expect(f.controls.getDetail({ ref: row.ref }).output).toBeUndefined();
			expect(() => f.controls.operateActivity({ ref: row.ref }, "cancel")).toThrow(
				expect.objectContaining({ code: "not_found" }),
			);
		} finally {
			getSnapshot.mockRestore();
		}
	});

	test("settled ownership drift and generation changes permanently reject old references", async () => {
		const f = await fixture();
		const job = monitor(f.manager, f.owner);
		const ref = f.controls.getActivitySnapshot().jobs[0]!.ref;
		const owner = spyOn(f.result.session, "getAgentId").mockReturnValue("foreign");
		try {
			expect(() => f.controls.operateActivity({ ref }, "cancel")).toThrow(
				expect.objectContaining({ code: "stale_session" }),
			);
		} finally {
			owner.mockRestore();
		}
		expect(() => f.controls.operateActivity({ ref }, "cancel")).toThrow(
			expect.objectContaining({ code: "stale_session" }),
		);
		expect(job.abortController.signal.aborted).toBe(false);
		const fresh = new ActivityControls(f.result);
		try {
			const snapshot = fresh.getActivitySnapshot();
			expect(await f.result.session.newSession()).toBe(true);
			expect(() => fresh.acknowledge({ ref: snapshot.ref })).toThrow(
				expect.objectContaining({ code: "stale_session" }),
			);
		} finally {
			fresh.dispose();
		}
	});

	test("transition exclusion rejects effects while read snapshots advertise no controls", async () => {
		const f = await fixture();
		monitor(f.manager, f.owner);
		const ref = f.controls.getActivitySnapshot().jobs[0]!.ref;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const maintenance = f.result.session.withMcpControlAdmission(
			f.result.session.sessionLifecycle.generation,
			async () => {
				entered.resolve();
				await release.promise;
			},
		);
		try {
			await entered.promise;
			expect(f.controls.getActivitySnapshot().jobs[0]!.controls).toEqual([]);
			expect(() => f.controls.operateActivity({ ref }, "cancel")).toThrow(
				expect.objectContaining({ code: "session_transitioning" }),
			);
		} finally {
			release.resolve();
			await maintenance;
		}
		expect(f.controls.operateActivity({ ref }, "cancel")).toEqual({ cancelled: true });
	});

	test("dispose detaches subscriptions without disposing the shared observation or manager", async () => {
		const f = await fixture();
		const job = monitor(f.manager, f.owner);
		const view = f.result.jobObservation!;
		let notifications = 0;
		f.controls.onChange(() => {
			notifications++;
		});
		f.controls.dispose();
		const afterDispose = notifications;
		f.manager.appendOutput(job.id, "later");
		await Bun.sleep(0);
		expect(notifications).toBe(afterDispose);
		expect(view.getSnapshot().jobs).toHaveLength(1);
		expect(job.abortController.signal.aborted).toBe(false);
		expect(() => f.controls.getActivitySnapshot()).toThrow(expect.objectContaining({ code: "disposed" }));
	});
});

describe("real MCP lifecycle adapter", () => {
	test("suspend/resume/reconnect use the captured factory manager and real SDK admission", async () => {
		const f = await mcpFixture();
		const admission = spyOn(f.result.session, "withMcpControlAdmission");
		try {
			let row = f.controls.getMcpSnapshot().servers[0]!;
			expect(row).toMatchObject({ label: "alpha", state: "connected", controls: ["suspend", "reconnect"] });
			expect(JSON.stringify(f.controls.getMcpSnapshot())).not.toContain("fixture-private-secret");
			expect(JSON.stringify(row)).not.toContain("binding");
			const before = f.initializes();
			expect(await f.controls.operateMcp({ ref: row.ref }, "suspend")).toEqual({
				status: "suspended",
				cleanup: "not_certified",
			});
			expect(f.deletes()).toBeGreaterThan(0);
			await expect(f.controls.operateMcp({ ref: row.ref }, "resume")).rejects.toMatchObject({
				code: "stale_target",
			});
			row = f.controls.getMcpSnapshot().servers[0]!;
			expect(row).toMatchObject({ state: "suspended", controls: ["resume"] });
			await f.controls.operateMcp({ ref: row.ref }, "resume");
			row = f.controls.getMcpSnapshot().servers[0]!;
			await f.controls.operateMcp({ ref: row.ref }, "reconnect");
			expect(f.initializes()).toBe(before + 2);
			expect(admission).toHaveBeenCalledTimes(4);
		} finally {
			admission.mockRestore();
		}
	}, 30_000);

	test("cross-service references, sealed manager, backend errors and missing capability fail explicitly", async () => {
		const f = await mcpFixture();
		const sibling = new ActivityControls(f.result);
		try {
			const row = f.controls.getMcpSnapshot().servers[0]!;
			await expect(sibling.operateMcp({ ref: row.ref }, "suspend")).rejects.toMatchObject({ code: "not_found" });
			f.mcp.sealConnectionSet();
			expect(f.controls.getMcpSnapshot().servers[0]!.controls).toEqual([]);
			await expect(f.controls.operateMcp({ ref: row.ref }, "suspend")).rejects.toMatchObject({
				code: "unsupported",
			});
			const backend = spyOn(f.mcp, "controlServer").mockRejectedValue(new Error("private credential"));
			try {
				await expect(f.controls.operateMcp({ ref: row.ref }, "suspend")).rejects.toMatchObject({
					code: "backend_failure",
					message: "SDK activity control: backend_failure",
				});
			} finally {
				backend.mockRestore();
			}
		} finally {
			sibling.dispose();
		}
		const absent = await fixture();
		expect(() => absent.controls.getMcpSnapshot()).toThrow(expect.objectContaining({ code: "unavailable" }));
	}, 30_000);

	test("MCP snapshots bound labels/counts/references and prune targets no longer observed", async () => {
		const f = await mcpFixture();
		const original = f.mcp.getServerControlSnapshot()[0]!;
		const read = spyOn(f.mcp, "getServerControlSnapshot").mockReturnValue(
			Array.from({ length: ACTIVITY_CONTROL_LIMITS.entries + 1 }, (_, index) => ({
				...original,
				target: { ...original.target, name: `server-${index}-${"x".repeat(ACTIVITY_CONTROL_LIMITS.fieldChars)}` },
				toolCount: Number.POSITIVE_INFINITY,
			})),
		);
		try {
			const snapshot = f.controls.getMcpSnapshot();
			expect(snapshot.servers).toHaveLength(ACTIVITY_CONTROL_LIMITS.entries);
			expect(snapshot.truncated).toBe(true);
			expect(
				snapshot.servers.every(
					row => row.label.length <= ACTIVITY_CONTROL_LIMITS.fieldChars && row.toolCount === 0,
				),
			).toBe(true);
			const ref = snapshot.servers[0]!.ref;
			read.mockReturnValue([]);
			expect(f.controls.getMcpSnapshot().servers).toEqual([]);
			await expect(f.controls.operateMcp({ ref }, "suspend")).rejects.toMatchObject({ code: "not_found" });
		} finally {
			read.mockRestore();
		}
	}, 30_000);

	test("real pending lifecycle rejects concurrent effects and disposal never reports an unproven success", async () => {
		const f = await mcpFixture();
		const row = f.controls.getMcpSnapshot().servers[0]!;
		const gate = f.blockDelete();
		const operation = f.controls.operateMcp({ ref: row.ref }, "suspend");
		const outcome = operation.then(
			() => "unexpected success",
			error => error as unknown,
		);
		try {
			await gate.entered;
			expect(f.controls.getMcpSnapshot().servers[0]!.controls).toEqual([]);
			await expect(f.controls.operateMcp({ ref: row.ref }, "suspend")).rejects.toMatchObject({
				code: "session_transitioning",
			});
			f.controls.dispose();
		} finally {
			gate.release();
		}
		expect(await outcome).toMatchObject({ code: "unknown_effect" });
	}, 30_000);
});
