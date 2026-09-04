import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { deepInterviewStatePath } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
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
		expect(JSON.parse(endpointId)).toEqual([
			"async-job-endpoint",
			"provider-session-id",
			sessionManager.getSessionFile(),
		]);

		const statePath = deepInterviewStatePath(cwd, sessionId);
		expect(statePath).toBe(path.join(cwd, ".gjc", `_session-${sessionId}`, "state", "deep-interview-state.json"));
		expect(statePath).not.toContain("%5B");
	} finally {
		await session.dispose();
	}
});
