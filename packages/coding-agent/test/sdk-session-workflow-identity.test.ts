import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager, asyncJobEndpointId } from "@gajae-code/coding-agent/async";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { deepInterviewStatePath } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { JobTool } from "@gajae-code/coding-agent/tools/job";
import { MonitorTool } from "@gajae-code/coding-agent/tools/monitor";
import { SubagentTool } from "@gajae-code/coding-agent/tools/subagent";
import { Snowflake } from "@gajae-code/utils";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("SDK tool session separates workflow identity from async endpoint identity", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-workflow-identity-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	const agentDir = path.join(tempDir, "agent");
	fs.mkdirSync(cwd, { recursive: true });

	const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	sessionManager.appendMessage({ role: "user", content: "persist transcript", timestamp: Date.now() });
	await sessionManager.flush();
	expect(sessionManager.getSessionFile()).not.toBeNull();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager,
		providerSessionId: "provider-session-id",
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: ["job"],
	});

	try {
		const job = session.getToolByName("job") as unknown as
			| { materializeForTests?: () => Promise<{ session?: ToolSession }> }
			| undefined;
		if (!job) throw new Error(`Job tool unavailable: ${session.getAllToolNames().join(", ")}`);
		const toolSession = (await job.materializeForTests?.())?.session;
		expect(toolSession).toBeDefined();

		const sessionId = toolSession?.getSessionId?.();
		const endpointId = toolSession?.getAsyncEndpointId?.();
		if (!sessionId || !endpointId) throw new Error("Expected SDK tool session identities");
		expect(sessionId).toBe(sessionManager.getSessionId());
		expect(sessionId).toMatch(/^[^/\\]+$/);
		expect(endpointId).not.toBe(sessionId);
		expect(endpointId).toBe(
			asyncJobEndpointId("provider-session-id", sessionManager.getSessionId(), sessionManager.getSessionFile()),
		);

		const statePath = deepInterviewStatePath(cwd, sessionId);
		expect(statePath).toBe(path.join(cwd, ".gjc", `_session-${sessionId}`, "state", "deep-interview-state.json"));
		expect(statePath).not.toContain("%5B");
		expect(sessionUltragoalDir(cwd, sessionId)).toBe(path.join(cwd, ".gjc", `_session-${sessionId}`, "ultragoal"));
	} finally {
		await session.dispose();
	}
});

test("async tools use the opaque endpoint while workflow consumers retain the logical id", async () => {
	const previousManager = AsyncJobManager.instance();
	const endpointManager = new AsyncJobManager({ onJobComplete: async () => {} });
	const foreignManager = new AsyncJobManager({ onJobComplete: async () => {} });
	const logicalSessionId = "workflow-session";
	const endpointId = asyncJobEndpointId("provider-session", logicalSessionId, "/tmp/workflow-session.jsonl");
	const endpointJobId = endpointManager.register("bash", "endpoint-owned", async () => "done");
	const foreignJobId = foreignManager.register("bash", "foreign", async () => "done");
	endpointManager.registerSubagentRecord({
		subagentId: "0-Endpoint",
		currentJobId: endpointJobId,
		historicalJobIds: [],
		status: "running",
		sessionFile: null,
		resumable: false,
	});
	foreignManager.registerSubagentRecord({
		subagentId: "0-Foreign",
		currentJobId: foreignJobId,
		historicalJobIds: [],
		status: "running",
		sessionFile: null,
		resumable: false,
	});

	try {
		expect(AsyncJobManager.registerForEndpoint(endpointId, endpointManager)).toBe(true);
		AsyncJobManager.setInstance(foreignManager);
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionId: () => logicalSessionId,
			getAsyncEndpointId: () => endpointId,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => undefined,
			sendCustomMessage: async () => {},
			purgeQueuedCustomMessages: () => ({
				agentSteering: 0,
				agentFollowUp: 0,
				pendingNextTurn: 0,
				displaySteering: 0,
				displayFollowUp: 0,
				totalExecutable: 0,
			}),
			allocateOutputArtifact: async () => ({}),
		} as unknown as ToolSession;

		const jobs = await new JobTool(session).execute("job-list", { list: true });
		expect(jobs.details?.jobs.map(job => job.label)).toContain("endpoint-owned");
		expect(jobs.details?.jobs.map(job => job.label)).not.toContain("foreign");

		const subagents = await new SubagentTool(session).execute("subagent-list", { action: "list" });
		expect(subagents.details?.subagents.map(subagent => subagent.id)).toContain("0-Endpoint");
		expect(subagents.details?.subagents.map(subagent => subagent.id)).not.toContain("0-Foreign");

		const endpointJobsBeforeMonitor = endpointManager.getAllJobs().length;
		const foreignJobsBeforeMonitor = foreignManager.getAllJobs().length;
		await new MonitorTool(session).execute("monitor-create", {
			command: "printf 'endpoint-routed\\n'",
			kind: "other",
			description: "endpoint routing regression",
			persistent: false,
		});
		expect(endpointManager.getAllJobs()).toHaveLength(endpointJobsBeforeMonitor + 1);
		expect(foreignManager.getAllJobs()).toHaveLength(foreignJobsBeforeMonitor);
	} finally {
		AsyncJobManager.unregisterManager(endpointManager);
		await endpointManager.dispose({ timeoutMs: 500 });
		await foreignManager.dispose({ timeoutMs: 500 });
		AsyncJobManager.setInstance(previousManager);
	}
});
