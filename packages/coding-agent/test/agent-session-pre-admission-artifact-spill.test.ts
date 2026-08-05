import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@gajae-code/coding-agent/config/settings-schema";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "@gajae-code/coding-agent/session/streaming-output";
import { logger, TempDir, withTimeout } from "@gajae-code/utils";

const SPILL_URI = /artifact:\/\/(\d+)/;

describe("AgentSession pre-admission artifact spill", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it("spills oversized UTF-8 tool results before provider admission and rehydrates byte-exactly", async () => {
		tempDir = TempDir.createSync("@gjc-pre-admission-spill-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");

		let providerContext: Context | undefined;
		let resolveWrite!: () => void;
		const writeGate = new Promise<void>(resolve => {
			resolveWrite = resolve;
		});
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
		const saveArtifact = sessionManager.saveArtifact.bind(sessionManager);
		(sessionManager as unknown as { saveArtifact: typeof sessionManager.saveArtifact }).saveArtifact = async (
			content,
			toolType,
		) => {
			await writeGate;
			return await saveArtifact(content, toolType);
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "tools.preAdmissionArtifactSpill": true }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessionRef = session;

		const fullText = `${"h".repeat(4095)}😀${"middle\n".repeat(10_000)}😀${"t".repeat(4095)}`;
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "large-read",
			toolName: "read",
			content: [{ type: "text", text: fullText }],
			isError: false,
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: toolResult });
		const prompt = session.prompt("continue without waiting for spill completion");
		await Bun.sleep(25);
		expect(providerContext).toBeUndefined();
		resolveWrite();
		await withTimeout(prompt, 1_000, "Provider did not resume after artifact spill");

		const preview = toolResult.content.find(block => block.type === "text");
		expect(preview?.type).toBe("text");
		if (preview?.type !== "text") throw new Error("Expected text preview");
		expect(preview.text).toStartWith("h".repeat(4095));
		expect(preview.text).toEndWith("t".repeat(4095));
		expect(Buffer.from(preview.text, "utf8").toString("utf8")).not.toContain("�");
		expect(preview.text).toContain(crypto.createHash("sha256").update(fullText).digest("hex"));
		const artifactId = preview.text.match(SPILL_URI)?.[1];
		expect(artifactId).toBeDefined();
		if (!artifactId) throw new Error("Expected artifact URI");
		expect(toolResult.details?.meta?.truncation?.artifactId).toBe(artifactId);
		expect(
			providerContext?.messages.some(message => JSON.stringify(message).includes(`artifact://${artifactId}`)),
		).toBe(true);
		const persisted = sessionManager
			.getBranch()
			.findLast(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === toolResult.toolCallId,
			);
		expect(persisted?.type).toBe("message");
		if (persisted?.type !== "message" || persisted.message.role !== "toolResult")
			throw new Error("Expected persisted receipt");
		const providerProjection = providerContext?.messages.find(
			message => message.role === "toolResult" && message.toolCallId === toolResult.toolCallId,
		);
		if (providerProjection?.role !== "toolResult") throw new Error("Expected provider receipt");
		expect(providerProjection).toEqual(persisted.message);

		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		expect(artifactPath).not.toBeNull();
		if (!artifactPath) throw new Error("Expected artifact path");
		expect(await fs.readFile(artifactPath, "utf8")).toBe(fullText);
		const resumed = await SessionManager.open(sessionManager.getSessionFile()!);
		expect(await resumed.getArtifactPath(artifactId)).toBe(artifactPath);

		await session.dispose();
		session = undefined;
		await sessionManager.dropSession(sessionManager.getSessionFile()!);
		expect(
			await fs.stat(path.dirname(artifactPath)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("preserves canonical tool-result bytes when pre-admission spilling is disabled by default", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: {
				model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: {} as never,
		});
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "default-off",
			toolName: "read",
			content: [{ type: "text", text: "😀".repeat(20_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		const expectedBytes = Buffer.from(JSON.stringify(toolResult));

		agent.emitExternalEvent({ type: "message_end", message: toolResult });
		await session.awaitPendingContextTransformations();
		await Bun.sleep(0);

		const persisted = sessionManager.getBranch().at(-1);
		expect(persisted?.type).toBe("message");
		if (persisted?.type !== "message") throw new Error("Expected persisted tool result");
		expect(Buffer.from(JSON.stringify(persisted.message))).toEqual(expectedBytes);
		expect(JSON.stringify(persisted.message)).not.toContain("artifact://");
		expect(persisted.message).not.toHaveProperty("details");
	});

	it("defaults pre-admission spill off and preserves an explicit setting through the settings schema", () => {
		expect(SETTINGS_SCHEMA["tools.preAdmissionArtifactSpill"].default).toBe(false);
		expect(Settings.isolated().get("tools.preAdmissionArtifactSpill")).toBe(false);
		expect(
			Settings.isolated({ "tools.preAdmissionArtifactSpill": false }).get("tools.preAdmissionArtifactSpill"),
		).toBe(false);
		expect(
			Settings.isolated({ "tools.preAdmissionArtifactSpill": true }).get("tools.preAdmissionArtifactSpill"),
		).toBe(true);
	});

	it("keeps the canonical inline tool result when artifact writing fails", async () => {
		tempDir = TempDir.createSync("@gjc-pre-admission-spill-failure-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: {
				model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		(sessionManager as unknown as { saveArtifact: typeof sessionManager.saveArtifact }).saveArtifact = async () => {
			throw new Error("simulated artifact write failure");
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "tools.preAdmissionArtifactSpill": true }),
			modelRegistry: {} as never,
		});
		const fullText = "💥".repeat(30_000);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "write-failure",
			toolName: "read",
			content: [{ type: "text", text: fullText }],
			isError: false,
			timestamp: Date.now(),
		};

		agent.emitExternalEvent({ type: "message_end", message: toolResult });
		await session.awaitPendingContextTransformations();
		await Bun.sleep(0);

		const persisted = sessionManager.getBranch().at(-1);
		expect(persisted?.type).toBe("message");
		if (persisted?.type !== "message") throw new Error("Expected persisted tool result");
		expect(persisted.message).toEqual(toolResult);
		expect(JSON.stringify(persisted.message)).not.toContain("artifact://");
	});

	it("uses a strict UTF-8 byte threshold and ignores every ineligible content shape", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.inMemory();
		const saved: string[] = [];
		const saveArtifact = sessionManager.saveArtifact.bind(sessionManager);
		(sessionManager as unknown as { saveArtifact: typeof sessionManager.saveArtifact }).saveArtifact = async (
			content,
			toolType,
		) => {
			saved.push(content);
			return await saveArtifact(content, toolType);
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.preAdmissionArtifactSpill": true,
				"tools.artifactSpillThreshold": 9,
			}),
			modelRegistry: {} as never,
		});

		const makeResult = (toolCallId: string, content: ToolResultMessage["content"]): ToolResultMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content,
			isError: false,
			timestamp: Date.now(),
		});
		const below = makeResult("below", [{ type: "text", text: "a".repeat(9 * 1024 - 1) }]);
		const equal = makeResult("equal", [{ type: "text", text: "界".repeat(3 * 1024) }]);
		const above = makeResult("above", [{ type: "text", text: `${"a".repeat(9 * 1024 - 3)}😀` }]);
		const twoTexts = makeResult("two-texts", [
			{ type: "text", text: "a".repeat(10 * 1024) },
			{ type: "text", text: "second" },
		]);
		const mixed = makeResult("mixed", [
			{ type: "text", text: "before".repeat(2_000) },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "after".repeat(2_000) },
		]);
		const unchanged = [below, equal, twoTexts, mixed].map(result => Buffer.from(JSON.stringify(result)));

		for (const result of [below, equal, above, twoTexts, mixed])
			agent.emitExternalEvent({ type: "message_end", message: result });
		await session.awaitPendingContextTransformations();
		await Bun.sleep(0);

		expect(saved).toEqual([above.content[0]?.type === "text" ? `${"a".repeat(9 * 1024 - 3)}😀` : ""]);
		expect(JSON.stringify(above)).toContain("artifact://");
		for (const [index, result] of [below, equal, twoTexts, mixed].entries())
			expect(Buffer.from(JSON.stringify(result))).toEqual(unchanged[index]!);
	});

	it("preserves every byte and emits one bounded sanitized diagnostic per storage disposition", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		(sessionManager as unknown as { saveArtifact: typeof sessionManager.saveArtifact }).saveArtifact =
			async content => {
				if (content.startsWith("undefined")) return undefined;
				if (content.startsWith("empty")) return "";
				if (content.startsWith("unreachable")) return "missing";
				throw Object.assign(new Error(`${"\u0000"}private\n${"x".repeat(200)}`), {
					name: `Storage${"\u202e"}Error${"y".repeat(100)}`,
				});
			};
		(sessionManager as unknown as { getArtifactPath: typeof sessionManager.getArtifactPath }).getArtifactPath =
			async () => null;
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.preAdmissionArtifactSpill": true,
				"tools.artifactSpillThreshold": 1,
			}),
			modelRegistry: {} as never,
		});
		const results = ["undefined", "empty", "unreachable", "throw"].map(prefix => ({
			role: "toolResult" as const,
			toolCallId: prefix,
			toolName: `${"\u0007"}read${"z".repeat(100)}`,
			content: [{ type: "text" as const, text: `${prefix}:${"💥".repeat(1_000)}` }],
			details: { paired: prefix },
			isError: false,
			timestamp: Date.now(),
		}));
		const before = results.map(result => Buffer.from(JSON.stringify(result)));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			for (const result of results) agent.emitExternalEvent({ type: "message_end", message: result });
			await session.awaitPendingContextTransformations();
			await Bun.sleep(0);

			for (const [index, result] of results.entries())
				expect(Buffer.from(JSON.stringify(result))).toEqual(before[index]!);
			const calls = warn.mock.calls.filter(
				([message]) => message === "Pre-admission artifact spill preserved inline tool result",
			);
			expect(calls).toHaveLength(4);
			for (const [, metadata] of calls) {
				expect(Object.keys(metadata ?? {}).sort()).toEqual(["error", "message", "outcome", "tool"]);
				const fields = metadata as Record<string, string>;
				expect([...fields.tool!].length).toBeLessThanOrEqual(64);
				expect([...fields.error!].length).toBeLessThanOrEqual(64);
				expect([...fields.message!].length).toBeLessThanOrEqual(128);
				expect(JSON.stringify(fields)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
			}
		} finally {
			warn.mockRestore();
		}
	});

	it("retains the only full copy when the artifact store cannot save it exactly", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		const save = vi.spyOn(sessionManager, "saveArtifact");
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.preAdmissionArtifactSpill": true,
				"tools.artifactSpillThreshold": 1,
			}),
			modelRegistry: {} as never,
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "over-artifact-cap",
			toolName: "read",
			content: [
				{
					type: "text",
					text: "界".repeat(Math.floor(DEFAULT_ARTIFACT_MAX_BYTES / 3) + 1),
				},
			],
			details: { stable: true },
			isError: false,
			timestamp: Date.now(),
		};
		const expected = Buffer.from(JSON.stringify(result));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			agent.emitExternalEvent({ type: "message_end", message: result });
			await session.awaitPendingContextTransformations();
			await Bun.sleep(0);

			expect(save).not.toHaveBeenCalled();
			expect(Buffer.from(JSON.stringify(result))).toEqual(expected);
			expect(
				warn.mock.calls.filter(
					([message, metadata]) =>
						message === "Pre-admission artifact spill preserved inline tool result" &&
						metadata?.outcome === "artifact_too_large",
				),
			).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
	it("preserves existing artifact metadata without resaving, whether reachable or stale", async () => {
		tempDir = TempDir.createSync("@gjc-pre-admission-spill-existing-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const artifactId = await sessionManager.saveArtifact("authoritative", "tool-result");
		expect(artifactId).toBeDefined();
		if (!artifactId) throw new Error("Expected artifact id");
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		expect(artifactPath).not.toBeNull();
		if (!artifactPath) throw new Error("Expected artifact path");
		const save = vi.spyOn(sessionManager, "saveArtifact");
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"tools.preAdmissionArtifactSpill": true,
				"tools.artifactSpillThreshold": 50,
			}),
			modelRegistry: {} as never,
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "existing",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(2 * 1024) }],
			details: { stable: true, meta: { truncation: { artifactId } } },
			isError: false,
			timestamp: Date.now(),
		};
		const expected = Buffer.from(JSON.stringify(result));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			agent.emitExternalEvent({ type: "message_end", message: result });
			await session.awaitPendingContextTransformations();
			await fs.rm(artifactPath);
			agent.emitExternalEvent({ type: "message_end", message: result });
			await session.awaitPendingContextTransformations();
			await Bun.sleep(0);

			expect(save).not.toHaveBeenCalled();
			expect(Buffer.from(JSON.stringify(result))).toEqual(expected);
			expect(
				warn.mock.calls.filter(
					([message]) => message === "Pre-admission artifact spill preserved inline tool result",
				),
			).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});
