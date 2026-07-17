import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	boundedRuntimePromptAckTimeoutMs,
	COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS,
} from "../src/coordinator-mcp/server";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "../src/gjc-runtime/session-state-sidecar";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

async function readState(stateFile: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fsp.readFile(stateFile, "utf8")) as Record<string, unknown>;
}
describe("Coordinator MCP runtime readiness", () => {
	it("bounds runtime acknowledgement waits independently of caller input", () => {
		expect(boundedRuntimePromptAckTimeoutMs(250)).toBe(250);
		expect(boundedRuntimePromptAckTimeoutMs(3_600_000)).toBe(COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS);
	});

	it("does not publish terminal runtime state until prompt and event-handler cleanup settle", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-runtime-idle-"));
		const stateFile = path.join(cwd, "runtime-state.json");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const stream = new AssistantMessageEventStream();
		const messageEndBarrier = Promise.withResolvers<void>();
		let messageEndHandlerStarted = false;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (_model, _context, options) => {
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
				});
				options?.signal?.addEventListener(
					"abort",
					() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
					{ once: true },
				);
				return stream;
			},
		});
		const extensionRunner = {
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				if (event.type !== "message_end") return;
				messageEndHandlerStarted = true;
				await messageEndBarrier.promise;
			},
		};
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			extensionRunner: extensionRunner as never,
		});
		const previousStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const previousSessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = session.sessionId;
		try {
			const prompt = session.prompt("hold open");
			await waitFor(() => session.isStreaming && fs.existsSync(stateFile), "running runtime state");
			session.agent.emitExternalEvent({
				type: "message_end",
				message: createAssistantMessage("wait for extension cleanup"),
			});
			await waitFor(() => messageEndHandlerStarted, "message_end extension handler");

			await session.abort();
			await Bun.sleep(25);
			expect((await readState(stateFile)).state).toBe("running");
			// The provider stream may have stopped already; readiness is the durable
			// terminal state, which must remain running until the handler barrier clears.

			messageEndBarrier.resolve();
			await prompt.catch(() => {});
			await waitFor(() => {
				if (!fs.existsSync(stateFile)) return false;
				const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { state?: unknown };
				return state.state === "completed" || state.state === "errored";
			}, "terminal runtime state");
		} finally {
			messageEndBarrier.resolve();
			if (previousStateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = previousStateFile;
			if (previousSessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = previousSessionId;
			await session.dispose();
			authStorage.close();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});
});
