import { expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionContext } from "../src/extensibility/extensions/types";
import { initializeExtensions } from "../src/modes/runtime-init";
import { AgentRegistry } from "../src/registry/agent-registry";
import { createAgentSession } from "../src/sdk/session";
import { getSdkClientControlOperations, getSessionClientControls } from "../src/sdk/session-client-controls";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Control = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
function object(value: unknown): Record<string, unknown> {
	expect(value).not.toBeNull();
	expect(typeof value).toBe("object");
	return value as Record<string, unknown>;
}

async function probe(operation: string, control: Control): Promise<void> {
	switch (operation) {
		case "model.roles.get": {
			const result = object(await control(operation, {}));
			expect(result).toHaveProperty("roles");
			return;
		}
		case "composer.catalog": {
			const result = object(await control(operation, {}));
			expect(Array.isArray(result.commands)).toBe(true);
			expect(typeof result.sessionGeneration).toBe("number");
			return;
		}
		case "activity.snapshot": {
			const result = object(await control(operation, {}));
			expect(Array.isArray(result.jobs)).toBe(true);
			expect(Array.isArray(result.tasks)).toBe(true);
			return;
		}
		case "diff.scopes":
			expect(await control(operation, {})).toEqual({
				scopes: [{ id: "working-tree", label: "Working tree (staged, unstaged, and untracked)" }],
			});
			return;
		case "btw.open": {
			const result = object(await control(operation, {}));
			expect(result.turns).toEqual([]);
			expect(await control("btw.close", { conversationId: result.id })).toEqual({ closed: true });
			return;
		}
		case "operator.execute": {
			const result = object(await control(operation, { text: "!! printf lifecycle-probe" }));
			expect(result.admission).toBe("accepted");
			const accepted = object(result.operation);
			const deadline = Date.now() + 3000;
			let current: Record<string, unknown>;
			do {
				current = object(object(await control("operator.read", { operationId: accepted.operationId })).operation);
				if (current.terminal) break;
				await Bun.sleep(10);
			} while (Date.now() < deadline);
			expect(current.terminal).toBe(true);
			expect(current.status).toBe("completed");
			expect(current.output).toBe("lifecycle-probe");
			return;
		}
		default:
			throw new Error(`Unexpected lifecycle probe ${operation}`);
	}
}

test("same initialized consumer stays usable after context clear and supported cwd move", async () => {
	using temp = TempDir.createSync("gjc-client-control-lifecycle-");
	using destination = TempDir.createSync("gjc-client-control-cwd-move-");
	const cwd = path.resolve(temp.path());
	const auth = await AuthStorage.create(":memory:");
	let ctx: ExtensionContext | undefined;
	const errors: unknown[] = [];
	const result = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: getBundledModel("openai", "gpt-4o-mini"),
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
		agentId: `cache-owner-${crypto.randomUUID()}`,
		agentRegistry: new AgentRegistry(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		sessionManager: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		sdkHostModeSupported: false,
		extensions: [
			api => {
				api.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
		toolNames: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
	});
	const { session } = result;
	try {
		await initializeExtensions(session, {
			reportSendError: (_action, error) => errors.push(error),
			reportRuntimeError: error => errors.push(error),
		});
		if (!ctx?.sdkControl) throw new Error("Expected initialized native SDK consumer");
		const context = ctx;
		const control: Control = async (operation, input) => await context.sdkControl!(operation, input);
		const operations = getSdkClientControlOperations(session);
		const probes = [
			"model.roles.get",
			"composer.catalog",
			"activity.snapshot",
			"diff.scopes",
			"btw.open",
			"operator.execute",
		].filter(operation => operations.includes(operation));
		if (!probes.length) throw new Error("Expected a generation-bound installed family");
		const manager = session.sessionManager;
		const sessionId = session.sessionId;
		const owner = session.getAgentId();
		const jobs = result.jobObservation;
		const jobManager = AsyncJobManager.forEndpoint(sessionId);
		const mcp = result.mcpManager;
		let oldActivityRef: unknown;
		let retainedJob: string | undefined;
		if (operations.includes("activity.snapshot")) {
			if (!jobManager) throw new Error("Expected the factory-owned manager");
			retainedJob = jobManager.register("bash", "retained lifecycle monitor", async () => "settled", {
				ownerId: owner,
				metadata: { monitor: true },
			});
			jobManager.acknowledgeDeliveries([retainedJob]);
			jobManager.appendOutput(retainedJob, "owned lifecycle output");
			await jobManager.waitForAll();
			const snapshot = object(await control("activity.snapshot", {}));
			oldActivityRef = object((snapshot.jobs as unknown[])[0]).ref;
			expect(await control("activity.detail", { ref: oldActivityRef })).toMatchObject({
				output: "owned lifecycle output",
			});
		}
		for (const operation of probes) await probe(operation, control);
		const previous = getSessionClientControls(session);
		const generation = session.sessionLifecycle.generation;
		expect(await context.clearContext()).toBe(true);
		expect(session.sessionLifecycle.generation).toBeGreaterThan(generation);
		for (const operation of probes) await probe(operation, control);
		const renewed = getSessionClientControls(session);
		expect(renewed).not.toBe(previous);
		expect(previous.retired).toBe(true);
		if (oldActivityRef !== undefined) {
			await expect(control("activity.detail", { ref: oldActivityRef })).rejects.toMatchObject({ code: "not_found" });
			const snapshot = object(await control("activity.snapshot", {}));
			const freshRef = object((snapshot.jobs as unknown[])[0]).ref;
			expect(freshRef).not.toBe(oldActivityRef);
			expect(await control("activity.detail", { ref: freshRef })).toMatchObject({
				output: "owned lifecycle output",
			});
		}
		expect(await control("bash.execute", { cmd: "printf native-cwd-probe" })).toMatchObject({
			exitCode: 0,
			output: "native-cwd-probe",
		});
		const target = path.resolve(destination.path());
		expect(await control("session.cwd.move", { path: target })).toEqual({ moved: true, cwd: target });
		expect(session.sessionManager).toBe(manager);
		expect(session.sessionId).toBe(sessionId);
		expect(await control("bash.execute", { cmd: "printf native-cwd-probe" })).toMatchObject({
			exitCode: 0,
			output: "native-cwd-probe",
		});
		for (const operation of probes) await probe(operation, control);
		expect(session.sessionManager).toBe(manager);
		expect(session.sessionId).toBe(sessionId);
		expect(session.getAgentId()).toBe(owner);
		expect(manager.getCwd()).toBe(target);
		if (jobs) {
			expect(result.jobObservation).not.toBe(jobs);
			expect(() => jobs.getSnapshot()).toThrow(expect.objectContaining({ code: "disposed" }));
			expect(result.jobObservation!.getSnapshot().jobs.map(job => job.id)).toEqual(retainedJob ? [retainedJob] : []);
		} else expect(result.jobObservation).toBeUndefined();
		expect(AsyncJobManager.forEndpoint(sessionId)).toBe(jobManager);
		expect(result.mcpManager).toBe(mcp);
		expect(getSdkClientControlOperations(session)).toEqual(operations);
		expect(errors).toEqual([]);
		const ownerMismatch = spyOn(session, "getAgentId").mockReturnValue("uncaptured-owner");
		try {
			for (let attempt = 0; attempt < 2; attempt++)
				expect(() => getSessionClientControls(session)).toThrow(expect.objectContaining({ code: "resource_gone" }));
		} finally {
			ownerMismatch.mockRestore();
		}
		expect(() => getSessionClientControls(session)).toThrow(expect.objectContaining({ code: "resource_gone" }));
		await session.dispose();
		expect(() => getSessionClientControls(session)).toThrow(expect.objectContaining({ code: "resource_gone" }));
	} finally {
		await session.dispose();
		auth.close();
	}
});
