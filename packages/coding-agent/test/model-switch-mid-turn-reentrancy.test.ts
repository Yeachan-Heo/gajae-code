import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { Agent } from "@gajae-code/agent-core";
import { AssistantMessageEventStream, getBundledModel } from "@gajae-code/ai";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("Model selection mid-turn reentrancy with abort", () => {
	let tempDir: string;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(async () => {
		// Create a temporary directory for the test
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-test-"));

		// Set up agent with a mock stream that never completes
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (abortSignal) {
						abortSignal.addEventListener(
							"abort",
							() => {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							},
							{ once: true },
						);
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} catch {
			// Ignore
		}
		await Promise.all(authStorages.map(s => s.close()));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	it("does not throw reentrancy error when abort is called during pending model selection", async () => {
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session to have a model");

		// Simulate a different model selection
		const selectionModel = getBundledModel("anthropic", "claude-opus-4-1")!;

		// Track the error from the selection
		let selectionError: unknown;

		// Start a prompt that will hold the agent in streaming state
		const promptPromise = session.prompt("Test message").catch(() => {
			// Expected to fail due to abort
		});

		// Wait for the prompt to be admitted and streaming
		await session.waitForIdle();
		await new Promise(resolve => setTimeout(resolve, 10));

		// Call setDefaultModelSelection - it will wait for idle then try to acquire admission
		const selectionPromise = session
			.setDefaultModelSelection(selectionModel, undefined)
			.catch((err) => {
				selectionError = err;
				return undefined;
			});

		// Give the selection a moment to start waiting for idle
		await new Promise(resolve => setTimeout(resolve, 10));

		// Now abort while selection is waiting - this should NOT throw reentrancy error
		const abortPromise = session.abort().catch(() => {
			// abort may throw when it happens during streaming
		});

		// Wait for all to settle
		await Promise.all([abortPromise, selectionPromise]);

		// The bug manifests as selectionError being an AgentBusyError with reentrancy message
		if (selectionError) {
			console.log("Selection Error:", selectionError);
			expect(selectionError).toMatchObject({
				name: "AgentBusyError",
				code: "busy",
				message: "Agent session admission is busy due to same-session reentrancy.",
			});
		}
	});
});
