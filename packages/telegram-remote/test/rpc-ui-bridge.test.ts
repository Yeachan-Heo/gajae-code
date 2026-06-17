import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcExtensionUIRequest, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { RpcAttachmentStore } from "../src/rpc-attachment-store";
import { FakeRpcBackend } from "../src/rpc-backend";
import { type RpcGatewayPolicy, TelegramRpcGateway } from "../src/rpc-gateway";
import { RpcUiBridge } from "../src/rpc-ui-bridge";
import { CallbackTokenStore } from "../src/tokens";
import { callback, message } from "./helpers";

const binding = { chatId: "900", userId: "100" };

function gate(): RpcWorkflowGate {
	return {
		type: "workflow_gate",
		gate_id: "gate-1",
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string" },
		schema_hash: "hash",
		options: [
			{ label: "Yes", value: "yes" },
			{ label: "No", value: "no" },
		],
		context: { title: "Approve?", prompt: "Approve bounded plan?" },
		created_at: "2026-06-16T00:00:00Z",
		required: true,
	};
}

async function gatewayWith(backend: FakeRpcBackend, tokens: CallbackTokenStore, now = () => 0) {
	const dir = await mkdtemp(join(tmpdir(), "gtr-rpc-ui-"));
	const attachments = await RpcAttachmentStore.open({ stateDir: dir });
	const policy: RpcGatewayPolicy = {
		allowedUserIds: new Set(["100"]),
		allowedChatIds: new Set(["900"]),
		defaultSocketPath: "/tmp/gjc.sock",
		allowAttachSocketArg: false,
	};
	return new TelegramRpcGateway(policy, { backend, attachments, tokens, now });
}

async function gatewayWithOutbound(backend: FakeRpcBackend, sent: Array<{ chatId: string; reply: unknown }>) {
	const dir = await mkdtemp(join(tmpdir(), "gtr-rpc-ui-outbound-"));
	const attachments = await RpcAttachmentStore.open({ stateDir: dir });
	const policy: RpcGatewayPolicy = {
		allowedUserIds: new Set(["100"]),
		allowedChatIds: new Set(["900"]),
		defaultSocketPath: "/tmp/gjc.sock",
		allowAttachSocketArg: false,
	};
	return new TelegramRpcGateway(policy, {
		backend,
		attachments,
		now: () => 0,
		outbound: {
			send: async message => {
				sent.push(message);
				return { ok: true };
			},
		},
	});
}

describe("RpcUiBridge", () => {
	test("select and confirm render opaque buttons", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		const bridge = new RpcUiBridge({ backend, tokens, binding });
		const select = await bridge.handleExtensionUiRequest({
			type: "extension_ui_request",
			id: "ui-1",
			method: "select",
			title: "Pick",
			options: ["A", "B"],
		});
		expect(select?.replyMarkup?.inline_keyboard.flat().map(button => button.text)).toEqual(["A", "B"]);
		for (const button of select?.replyMarkup?.inline_keyboard.flat() ?? []) {
			expect(button.callbackData.startsWith("gtr:v1:")).toBe(true);
			expect(Buffer.byteLength(button.callbackData)).toBeLessThanOrEqual(64);
			expect(button.callbackData).not.toContain("ui-1");
			expect(button.callbackData).not.toContain("Pick");
		}
		const confirm = await bridge.handleExtensionUiRequest({
			type: "extension_ui_request",
			id: "ui-2",
			method: "confirm",
			title: "Sure?",
			message: "Do it?",
		});
		expect(confirm?.replyMarkup?.inline_keyboard.flat().map(button => button.text)).toEqual(["Yes", "No"]);
	});

	test("replayed pending gate renders and gate answer is idempotent single-use", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		backend.pendingWorkflowGates = [gate()];
		const sent: unknown[] = [];
		const bridge = new RpcUiBridge({
			backend,
			tokens,
			binding,
			onMessage: reply => {
				sent.push(reply);
			},
		});
		await bridge.replayPendingWorkflowGates();
		const rendered = sent[0] as { replyMarkup: { inline_keyboard: Array<Array<{ callbackData: string }>> } };
		const data = rendered.replyMarkup.inline_keyboard[0][0].callbackData;
		const gateway = await gatewayWith(backend, tokens);
		const first = await gateway.handleUpdate(callback({ chatId: "900", data }));
		const second = await gateway.handleUpdate(callback({ chatId: "900", data }));
		expect(first.kind === "callback_answer" ? first.callbackAnswer.text : "").toBe("Done.");
		expect(second.kind === "callback_answer" ? second.callbackAnswer.text : "").toBe(
			"That button is no longer valid.",
		);
		const gateCalls = backend.calls.filter(call => call.method === "respondGate");
		expect(gateCalls).toHaveLength(1);
		expect((gateCalls[0].args as { idempotencyKey: string }).idempotencyKey).toStartWith("tg:");
	});

	test("input/editor use next authorized text and unsupported blocking UI is cancelled", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		const gateway = await gatewayWith(backend, tokens);
		await gateway.handleUpdate(message({ text: "/attach" }));
		const request: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "input-1",
			method: "input",
			title: "Answer",
		};
		backend.emitExtensionUiRequest(request);
		await gateway.handleUpdate(message({ text: "typed answer" }));
		expect(backend.calls).toContainEqual({
			method: "respondExtensionUi",
			args: { type: "extension_ui_response", id: "input-1", value: "typed answer" },
		});
		backend.emitExtensionUiRequest({
			type: "extension_ui_request",
			id: "url-1",
			method: "open_url",
			url: "https://example.invalid",
		});
		expect(backend.calls).toContainEqual({
			method: "respondExtensionUi",
			args: { type: "extension_ui_response", id: "url-1", cancelled: true },
		});
	});

	test("input text response reports Sent. after a non-throwing fire-and-forget write", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		const gateway = await gatewayWith(backend, tokens);
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.emitExtensionUiRequest({ type: "extension_ui_request", id: "input-9", method: "input", title: "Answer" });
		const reply = await gateway.handleUpdate(message({ text: "typed answer" }));
		expect(reply).toEqual({ kind: "chat", text: "Sent." });
		expect(backend.calls).toContainEqual({
			method: "respondExtensionUi",
			args: { type: "extension_ui_response", id: "input-9", value: "typed answer" },
		});
	});

	test("input text response retains the pending request and reports failure when the write throws", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		const gateway = await gatewayWith(backend, tokens);
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.emitExtensionUiRequest({
			type: "extension_ui_request",
			id: "input-10",
			method: "input",
			title: "Answer",
		});
		backend.failRespondExtensionUi = true;
		const failed = await gateway.handleUpdate(message({ text: "first try" }));
		expect(failed.kind === "chat" ? failed.text : "").toContain("Couldn't deliver");
		expect(backend.calls.some(call => call.method === "respondExtensionUi")).toBe(false);
		backend.failRespondExtensionUi = false;
		const ok = await gateway.handleUpdate(message({ text: "second try" }));
		expect(ok).toEqual({ kind: "chat", text: "Sent." });
		expect(backend.calls).toContainEqual({
			method: "respondExtensionUi",
			args: { type: "extension_ui_response", id: "input-10", value: "second try" },
		});
	});

	test("unauthorized callback default-denies and non-actionable UI is quiet", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		const bridge = new RpcUiBridge({ backend, tokens, binding });
		const rendered = await bridge.renderWorkflowGate(gate());
		const data = rendered.replyMarkup!.inline_keyboard[0][0].callbackData;
		const gateway = await gatewayWith(backend, tokens);
		const denied = await gateway.handleUpdate(callback({ userId: "999", chatId: "999", data }));
		expect(denied.kind === "callback_answer" ? denied.callbackAnswer.text : "").toBe("Not authorized.");
		expect(backend.countOf("respondGate")).toBe(0);
		const quiet = await bridge.handleExtensionUiRequest({
			type: "extension_ui_request",
			id: "n-1",
			method: "notify",
			message: "noise",
		});
		expect(quiet).toBeNull();
	});
	test("gateway delivers emitted UI and workflow gates to the attached chat", async () => {
		const backend = new FakeRpcBackend();
		const sent: Array<{ chatId: string; reply: { text: string } }> = [];
		const gateway = await gatewayWithOutbound(backend, sent as Array<{ chatId: string; reply: unknown }>);
		await gateway.handleUpdate(message({ chatId: "900", userId: "100", text: "/attach" }));
		backend.emitExtensionUiRequest({
			type: "extension_ui_request",
			id: "select-1",
			method: "select",
			title: "Pick one",
			options: ["A", "B"],
		});
		backend.emitWorkflowGate(gate());
		await Promise.resolve();
		await Promise.resolve();
		expect(sent.map(item => item.chatId)).toEqual(["900", "900"]);
		expect(sent[0].reply.text).toContain("Pick one");
		expect(sent[1].reply.text).toContain("Approve bounded plan?");
	});

	test("gateway attach replays pending workflow gates to the attached chat", async () => {
		const backend = new FakeRpcBackend();
		backend.pendingWorkflowGates = [gate()];
		const sent: Array<{ chatId: string; reply: { text: string } }> = [];
		const gateway = await gatewayWithOutbound(backend, sent as Array<{ chatId: string; reply: unknown }>);
		await gateway.handleUpdate(message({ chatId: "900", userId: "100", text: "/attach" }));
		expect(sent).toHaveLength(1);
		expect(sent[0].chatId).toBe("900");
		expect(sent[0].reply.text).toContain("Approve bounded plan?");
		expect(backend.countOf("getPendingWorkflowGates")).toBe(1);
	});

	test("editor response preserves multiline formatting", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		const gateway = await gatewayWith(backend, tokens);
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.emitExtensionUiRequest({
			type: "extension_ui_request",
			id: "editor-1",
			method: "editor",
			title: "Edit",
		});
		await gateway.handleUpdate(message({ text: "line one\n\tline two\nline three\u0000" }));
		expect(backend.calls).toContainEqual({
			method: "respondExtensionUi",
			args: { type: "extension_ui_response", id: "editor-1", value: "line one\n\tline two\nline three" },
		});
	});

	test("rejected gate callback returns rejection feedback without consuming token", async () => {
		const tokens = new CallbackTokenStore({ now: () => 0 });
		const backend = new FakeRpcBackend();
		backend.respondGate = async (gateId, answer, idempotencyKey) => {
			backend.calls.push({ method: "respondGate", args: { gateId, answer, idempotencyKey } });
			return { gate_id: gateId, accepted: false };
		};
		const rendered = await new RpcUiBridge({ backend, tokens, binding }).renderWorkflowGate(gate());
		const data = rendered.replyMarkup!.inline_keyboard[0][0].callbackData;
		const gateway = await gatewayWith(backend, tokens);
		const first = await gateway.handleUpdate(callback({ chatId: "900", data }));
		const second = await gateway.handleUpdate(callback({ chatId: "900", data }));
		expect(first.kind === "callback_answer" ? first.callbackAnswer.text : "").toBe("Request was rejected.");
		expect(second.kind === "callback_answer" ? second.callbackAnswer.text : "").toBe("Request was rejected.");
		expect(backend.countOf("respondGate")).toBe(2);
	});
});
