import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessage, StopReason } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { entriesFromMessages } from "../src/modes/components/session-observer-overlay";
import { composeToolText } from "../src/modes/components/tool-transcript-format";
import { transcriptViewerEntries } from "../src/modes/components/transcript-viewer-overlay";
import { TranscriptItemRegistry } from "../src/modes/transcript-item-registry";
import type { AgentSession } from "../src/session/agent-session";
import { type ProductionSdkHost, startProductionSdkHost } from "./helpers/sdk-production-host";

const assistantStopReasons: StopReason[] = ["stop", "length", "toolUse", "aborted", "error"];
const fullAssistantText = `Full canonical response\n${"long response body ".repeat(100)}\x1b[31mraw bytes\x1b[0m`;
const finalAssistantText = "Final block after redacted thinking.";

function transcriptAssistant(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		content: [
			{ type: "thinking", thinking: "Canonical thinking", thinkingSignature: "private-signature" },
			{ type: "text", text: fullAssistantText },
			{ type: "redactedThinking", data: "cHJpdmF0ZQ==" },
			{ type: "text", text: finalAssistantText },
			...(stopReason === "toolUse"
				? [{ type: "toolCall" as const, id: "canonical-call", name: "bash", arguments: { command: "pwd" } }]
				: []),
		],
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

describe("AgentSession.getTranscript authoritative assistant stop reason", () => {
	let directory: TempDir;
	let host: ProductionSdkHost | undefined;
	let session: AgentSession;

	beforeAll(async () => {
		directory = TempDir.createSync();
		host = await startProductionSdkHost(directory.path());
		session = host.session;
	});

	afterAll(async () => {
		try {
			await host?.stop();
		} finally {
			directory?.removeSync();
		}
	});

	test.each(assistantStopReasons)("preserves canonical %s without changing ID, full body, or blocks", stopReason => {
		const message = transcriptAssistant(stopReason);
		const previousIds = session.getTranscript().map(entry => entry.id);
		const id = session.sessionManager.appendMessage(message);
		const transcript = session.getTranscript();
		const entry = transcript.at(-1);
		const body = `${fullAssistantText}\n${finalAssistantText}`;
		expect(transcript.map(item => item.id)).toEqual([...previousIds, id]);
		expect(entry).toMatchObject({ id, role: "assistant", body, textSummary: body.slice(0, 500) });
		expect(session.getTranscriptBody(id)).toBe(body);
		expect(entry?.content).toEqual([
			{ type: "thinking", thinking: "Canonical thinking" },
			{ type: "text", text: fullAssistantText },
			{ type: "text", text: finalAssistantText },
			...(stopReason === "toolUse"
				? [{ type: "toolCall" as const, id: "canonical-call", name: "bash", arguments: { command: "pwd" } }]
				: []),
		]);
		expect(JSON.stringify(entry)).not.toContain("private-signature");
		expect(JSON.stringify(entry)).not.toContain("cHJpdmF0ZQ==");
		expect(entry).toMatchObject({ stopReason });
	});

	test("keeps a missing assistant reason unknown even with full text and no tool calls", () => {
		const message = transcriptAssistant("stop");
		// Legacy persisted messages may predate authoritative stop-reason metadata.
		const legacyMessage: Partial<AssistantMessage> = { ...message };
		delete legacyMessage.stopReason;
		const id = session.sessionManager.appendMessage(legacyMessage as AssistantMessage);
		const entry = session.getTranscript().find(item => item.id === id);
		const body = `${fullAssistantText}\n${finalAssistantText}`;
		expect(entry).toMatchObject({ id, role: "assistant", body, textSummary: body.slice(0, 500) });
		expect(session.getTranscriptBody(id)).toBe(body);
		expect(entry).not.toHaveProperty("stopReason");
	});

	test("never exposes assistant stop reasons on non-assistant entries", () => {
		const userMessage = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: fullAssistantText },
				{ type: "image" as const, data: "cHJpdmF0ZQ==", mimeType: "image/png" },
			],
			timestamp: 2,
			stopReason: "stop",
		};
		const toolMessage = {
			role: "toolResult" as const,
			toolCallId: "canonical-call",
			toolName: "bash",
			content: [{ type: "text" as const, text: finalAssistantText }],
			isError: true,
			timestamp: 3,
			stopReason: "error",
		};
		const userId = session.sessionManager.appendMessage(userMessage);
		const toolId = session.sessionManager.appendMessage(toolMessage);
		const transcript = session.getTranscript();
		const userEntry = transcript.find(entry => entry.id === userId);
		const toolEntry = transcript.find(entry => entry.id === toolId);
		expect(transcript.slice(-2).map(entry => entry.id)).toEqual([userId, toolId]);
		expect(userEntry).toMatchObject({ id: userId, role: "user", body: fullAssistantText });
		expect(toolEntry).toMatchObject({
			id: toolId,
			role: "toolResult",
			body: finalAssistantText,
			toolCallId: "canonical-call",
			toolName: "bash",
			isError: true,
		});
		expect(session.getTranscriptBody(userId)).toBe(fullAssistantText);
		expect(session.getTranscriptBody(toolId)).toBe(finalAssistantText);
		expect(userEntry?.content).toEqual([{ type: "text", text: fullAssistantText }]);
		expect(JSON.stringify(userEntry)).not.toContain("cHJpdmF0ZQ==");
		expect(userEntry).not.toHaveProperty("stopReason");
		expect(toolEntry).not.toHaveProperty("stopReason");
	});
});

const hostileResult = "result\x1b]52;c;clipboard\x07\x1bPdata\x1b\\\x1b[2J\x01\x80";
const fields = {
	name: "bash",
	args: { command: "printf hostile" },
	intent: "Inspect hostile bytes",
	resultText: hostileResult,
	isError: true,
	hasResult: true,
};
const hostileDetails = {
	diff: "--- a/file\n+++ b/file\n\x1b]52;c;clipboard\x07",
	perFileResults: [{ path: "src/\x1b[31mfile.ts", diff: "\x1bPdata\x1b\\" }],
};

test("tool adapters preserve canonical bytes and use sanitized frozen display descriptors", () => {
	const canonical = composeToolText(fields);
	const registry = new TranscriptItemRegistry();
	registry.register({
		id: "tool:call",
		kind: "tool",
		source: fields,
		getPayload: () => ({
			text: canonical,
			metadata: {
				name: fields.name,
				arguments: fields.args,
				intent: fields.intent,
				resultText: fields.resultText,
				isError: fields.isError,
				hasResult: fields.hasResult,
				detailsData: hostileDetails,
			},
			source: fields,
		}),
	});
	const main = transcriptViewerEntries(registry)[0]!;
	const observer = entriesFromMessages([
		{
			id: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call", name: fields.name, arguments: fields.args, intent: fields.intent },
				],
			},
		},
		{
			id: "result",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: fields.name,
				content: [{ type: "text", text: fields.resultText }],
				isError: fields.isError,
				details: hostileDetails,
			},
		},
	] as unknown as Parameters<typeof entriesFromMessages>[0])[0]!;

	expect(main.label).toBe(observer.label);
	expect(main.payload.text).toBe(canonical);
	expect(observer.payload.text).toBe(canonical);
	expect(main.payload.text).toContain("\x1b]52;c;clipboard\x07");
	expect(observer.payload.text).toContain("\x1b]52;c;clipboard\x07");
	expect(JSON.stringify(main.payload.metadata)).toBe(JSON.stringify(observer.payload.metadata));
	expect(main.getDisplayText?.(true)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	expect(observer.getDisplayText?.(true)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	expect(main.renderDescriptor?.detailsData).toEqual(observer.renderDescriptor?.detailsData);
	expect(JSON.stringify(main.renderDescriptor?.detailsData)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	expect(Object.isFrozen(main.renderDescriptor?.detailsData as object)).toBe(true);
	expect(Object.isFrozen((main.renderDescriptor?.detailsData as { perFileResults: unknown[] }).perFileResults)).toBe(
		true,
	);
});
