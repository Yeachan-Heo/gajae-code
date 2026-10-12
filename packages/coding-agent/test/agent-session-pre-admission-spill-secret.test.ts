import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { obfuscateMessages, SecretObfuscator } from "@gajae-code/coding-agent/secrets";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@gajae-code/utils";

const SPILL_URI = /artifact:\/\/(\d+)/;

describe("pre-admission spill secret boundary", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it(
		"redacts a secret that straddles the spill cut before the provider request",
		async () => {
			const canary = "GJCCANARY-SPILL-7f3a9d2e-SECRETVALUE-DO-NOT-LEAK";
			const bodyBytes = 65_536;
			const headBytes = 4096;
			const tailBytes = 4096;
			const key = new Uint8Array(32).fill(7);
			const obfuscator = new SecretObfuscator([{ type: "plain", content: canary }], key);
			const placeholder = obfuscator.obfuscate(canary);
			expect(placeholder).not.toBe(canary);

			const secretWindow = (haystack: string): string | undefined => {
				const scanned = haystack.split(placeholder).join("");
				for (let size = canary.length; size >= 6; size--) {
					for (let start = 0; start + size <= canary.length; start++) {
						const window = canary.slice(start, start + size);
						if (scanned.includes(window)) return window;
					}
				}
				return undefined;
			};

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic model");

			const scenarios = [
				{ name: "head-straddle", offset: headBytes - 6, spill: true, placeholderInRequest: true },
				{ name: "tail-straddle", offset: bodyBytes - tailBytes - 6, spill: true, placeholderInRequest: true },
				{ name: "head-inside", offset: 64, spill: true, placeholderInRequest: true },
				{ name: "middle-elided", offset: 20_000, spill: true, placeholderInRequest: false },
				{ name: "no-spill", offset: headBytes - 6, spill: false, placeholderInRequest: true },
			] as const;

			for (const scenario of scenarios) {
				if (scenario.offset < 0 || scenario.offset + canary.length > bodyBytes) {
					throw new Error(`${scenario.name} canary does not fit in the tool result`);
				}
				const fullText = `${"x".repeat(scenario.offset)}${canary}${"x".repeat(bodyBytes - scenario.offset - canary.length)}`;
				tempDir = TempDir.createSync(`@gjc-spill-secret-${scenario.name}-`);
				authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
				authStorage.setRuntimeApiKey("anthropic", "test-key");

				let providerContext: Context | undefined;
				let sessionRef: AgentSession | undefined;
				const agent = new Agent({
					initialState: {
						model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
					},
					convertToLlm: messages => obfuscateMessages(obfuscator, convertToLlm(messages)),
					transformContext: async messages => {
						await sessionRef?.awaitPendingContextTransformations();
						return messages;
					},
					streamFn: (_model, context) => {
						providerContext = context;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							const message: AssistantMessage = {
								role: "assistant",
								content: [{ type: "text", text: "done" }],
								api: "anthropic-messages",
								provider: "anthropic",
								model: "claude-sonnet-4-5",
								stopReason: "stop",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								timestamp: Date.now(),
							};
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: "stop", message });
						});
						return stream;
					},
				});
				const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
				sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
				session = new AgentSession({
					agent,
					sessionManager,
					settings: Settings.isolated({ "tools.preAdmissionArtifactSpill": scenario.spill }),
					modelRegistry: new ModelRegistry(authStorage),
					obfuscator,
				});
				sessionRef = session;

				const toolResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: scenario.name,
					toolName: "read",
					content: [{ type: "text", text: fullText }],
					isError: false,
					timestamp: Date.now(),
				};
				agent.emitExternalEvent({ type: "message_end", message: toolResult });
				await withTimeout(session.prompt("continue"), 5_000, `${scenario.name} did not reach the provider`);
				if (!providerContext) throw new Error(`${scenario.name} did not capture a provider context`);

				const request = JSON.stringify(providerContext.messages);
				const digest = crypto.createHash("sha256").update(fullText).digest("hex");
				const leaked = secretWindow(request.split(digest).join(""));
				expect(leaked, scenario.name).toBeUndefined();
				expect(request.includes(canary), scenario.name).toBe(false);
				expect(request.includes(placeholder), scenario.name).toBe(scenario.placeholderInRequest);

				if (scenario.spill) {
					const artifactId = request.match(SPILL_URI)?.[1];
					if (!artifactId) throw new Error(`${scenario.name} did not spill to an artifact`);
					const artifactPath = await sessionManager.getArtifactPath(artifactId);
					if (!artifactPath) throw new Error(`${scenario.name} artifact path is missing`);
					expect(await fs.readFile(artifactPath, "utf8")).toBe(fullText);
				} else {
					expect(request).not.toContain("artifact://");
				}

				await session.dispose();
				session = undefined;
				authStorage.close();
				authStorage = undefined;
				tempDir.removeSync();
				tempDir = undefined;
			}
		},
		{ timeout: 60_000 },
	);

	it(
		"keeps the 4096-byte spill cut when secrets are off and the text contains a placeholder",
		async () => {
			const token = `#GJC1_${"A".repeat(22)}#`;
			const bodyBytes = 65_536;
			const offset = 4096 - 6;
			if (offset + token.length > bodyBytes) throw new Error("placeholder does not fit in the tool result");
			const fullText = `${"x".repeat(offset)}${token}${"x".repeat(bodyBytes - offset - token.length)}`;
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic model");

			tempDir = TempDir.createSync("@gjc-spill-no-secret-placeholder-");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			let providerContext: Context | undefined;
			let sessionRef: AgentSession | undefined;
			const agent = new Agent({
				initialState: {
					model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				transformContext: async messages => {
					await sessionRef?.awaitPendingContextTransformations();
					return messages;
				},
				streamFn: (_model, context) => {
					providerContext = context;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "claude-sonnet-4-5",
							stopReason: "stop",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			});
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "tools.preAdmissionArtifactSpill": true }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			sessionRef = session;
			agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "placeholder-shaped",
					toolName: "read",
					content: [{ type: "text", text: fullText }],
					isError: false,
					timestamp: Date.now(),
				},
			});
			await withTimeout(session.prompt("continue"), 5_000, "placeholder-shaped spill did not reach the provider");
			if (!providerContext) throw new Error("placeholder-shaped spill did not capture a provider context");
			const request = JSON.stringify(providerContext.messages);
			const receiptAt = request.indexOf("\\n\\n[");
			if (receiptAt < 0) throw new Error("spill receipt is missing from the provider context");
			const head = request.slice(receiptAt - 4096, receiptAt);
			expect(head).toBe(fullText.slice(0, 4096));
			expect(request).toContain("57344 bytes omitted");
			expect(request).not.toContain(token);
		},
		{ timeout: 30_000 },
	);
});
