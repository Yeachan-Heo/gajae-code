import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES } from "../src/messages";
import { RpcAttachmentStore } from "../src/rpc-attachment-store";
import { FakeRpcBackend } from "../src/rpc-backend";
import { type RpcGatewayPolicy, TelegramRpcGateway } from "../src/rpc-gateway";
import { callback, message } from "./helpers";

let backend: FakeRpcBackend;
let attachments: RpcAttachmentStore;
let clock: number;

async function makeGateway(overrides: Partial<RpcGatewayPolicy> = {}): Promise<TelegramRpcGateway> {
	const dir = await mkdtemp(join(tmpdir(), "gtr-rpc-gateway-"));
	attachments = await RpcAttachmentStore.open({ stateDir: dir });
	backend = new FakeRpcBackend();
	return new TelegramRpcGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(["900"]),
			defaultSocketPath: "/tmp/gjc.sock",
			allowAttachSocketArg: false,
			...overrides,
		},
		{ backend, attachments, now: () => clock },
	);
}

beforeEach(() => {
	backend = new FakeRpcBackend();
	clock = 0;
});

function buttonData(reply: Awaited<ReturnType<TelegramRpcGateway["handleUpdate"]>>, text: string): string {
	const button = activeChoiceButtons(reply).find(item => item.text === text);
	expect(button).toBeDefined();
	return button!.callbackData;
}

function activeChoiceButtons(reply: Awaited<ReturnType<TelegramRpcGateway["handleUpdate"]>>) {
	if (reply.kind !== "chat") return [];
	return reply.replyMarkup?.inline_keyboard.flat() ?? [];
}

function expectOpaqueCallbackData(data: string): void {
	expect(data).toMatch(/^gtr:v1:[A-Za-z0-9_-]+$/);
	expect(data).not.toBe("gtr:v1:steer-held");
	expect(data).not.toBe("gtr:v1:cancel-steer");
	expect(data).not.toBe("gtr:v1:abort");
}

describe("TelegramRpcGateway", () => {
	test("unauthorized refusal happens before RPC control", async () => {
		const gateway = await makeGateway();
		const reply = await gateway.handleUpdate(message({ userId: "999", chatId: "999", text: "hello" }));
		expect(reply).toEqual({ kind: "chat", text: "Not authorized." });
		expect(backend.calls).toHaveLength(0);
	});

	test("free text routes to prompt while idle and holds active text for operator choice", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		await gateway.handleUpdate(message({ text: "start work" }));
		backend.state = { ...backend.state, session: { status: "active", turnId: "turn-1" } };
		const reply = await gateway.handleUpdate(message({ text: "adjust course" }));
		const buttons = activeChoiceButtons(reply);
		expect(reply.kind).toBe("chat");
		expect(reply.kind === "chat" ? reply.text : "").toBe("Choose how to apply this input.");
		expect(buttons.map(button => button.text)).toEqual(["Steer", "Cancel & steer"]);
		for (const button of buttons) expectOpaqueCallbackData(button.callbackData);
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["prompt", "start work"]);
		expect(backend.calls.map(call => [call.method, call.args])).not.toContainEqual(["steer", "adjust course"]);
		expect(backend.calls.map(call => [call.method, call.args])).not.toContainEqual([
			"abortAndPrompt",
			"adjust course",
		]);
	});

	test("active-turn text then steer callback maps to exactly one steer op", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.state = { ...backend.state, session: { status: "active", turnId: "old" } };
		const steerText = "new direction";
		const promptReply = await gateway.handleUpdate(message({ text: steerText }));
		const callbacks = activeChoiceButtons(promptReply).map(button => button.callbackData);
		expect(callbacks).toHaveLength(2);
		for (const data of callbacks) expectOpaqueCallbackData(data);
		expect(callbacks.join(" ")).not.toContain(steerText);
		const update = callback({ data: buttonData(promptReply, "Steer") });
		expect(update.data).not.toContain(steerText);
		const reply = await gateway.handleUpdate(update);
		expect(reply).toEqual({
			kind: "callback_answer",
			callbackAnswer: { text: "Steer queued." },
			sendMessage: false,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["steer", steerText]);
		expect(backend.countOf("steer")).toBe(1);
		expect(backend.countOf("abortAndPrompt")).toBe(0);
	});

	test("replacing held text invalidates old steer and cancel buttons", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.state = { ...backend.state, session: { status: "active", turnId: "old" } };
		const firstReply = await gateway.handleUpdate(message({ text: "old direction" }));
		const oldSteer = buttonData(firstReply, "Steer");
		const oldCancel = buttonData(firstReply, "Cancel & steer");
		const secondReply = await gateway.handleUpdate(message({ text: "new direction" }));
		const newSteer = buttonData(secondReply, "Steer");

		expect(await gateway.handleUpdate(callback({ data: oldSteer }))).toEqual({
			kind: "callback_answer",
			callbackAnswer: { text: MESSAGES.callbackInvalid },
			sendMessage: false,
		});
		expect(await gateway.handleUpdate(callback({ data: oldCancel }))).toEqual({
			kind: "callback_answer",
			callbackAnswer: { text: MESSAGES.callbackInvalid },
			sendMessage: false,
		});

		const applied = await gateway.handleUpdate(callback({ data: newSteer }));
		expect(applied.kind === "callback_answer" ? applied.callbackAnswer.text : "").toBe("Steer queued.");
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["steer", "new direction"]);
		expect(backend.calls.map(call => [call.method, call.args])).not.toContainEqual(["steer", "old direction"]);
		expect(backend.countOf("steer")).toBe(1);
	});

	test("/abort maps to backend abort", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.state = { ...backend.state, session: { status: "idle" } };
		const reply = await gateway.handleUpdate(message({ text: "/abort" }));
		expect(reply).toEqual({ kind: "chat", text: "Abort requested." });
		expect(backend.countOf("abort")).toBe(1);
	});

	test("cancel-and-steer callback maps pending active text to one abort_and_prompt op", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.state = { ...backend.state, session: { status: "active", turnId: "old" } };
		const steerText = "new direction";
		const promptReply = await gateway.handleUpdate(message({ text: steerText }));
		const callbacks = activeChoiceButtons(promptReply).map(button => button.callbackData);
		expect(callbacks).toHaveLength(2);
		for (const data of callbacks) expectOpaqueCallbackData(data);
		expect(callbacks.join(" ")).not.toContain(steerText);
		const update = callback({ data: buttonData(promptReply, "Cancel & steer") });
		expect(update.data).not.toBe("gtr:v1:cancel-steer");
		expect(update.data).not.toContain(steerText);
		const reply = await gateway.handleUpdate(update);
		expect(reply).toEqual({
			kind: "callback_answer",
			callbackAnswer: { text: "Cancel & steer queued." },
			sendMessage: false,
		});
		expect(backend.calls.map(call => [call.method, call.args])).not.toContainEqual(["steer", steerText]);
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["abortAndPrompt", steerText]);
		await Promise.resolve();
		await Promise.resolve();
		expect(backend.countOf("abortAndPrompt")).toBe(1);
		expect(backend.countOf("steer")).toBe(0);
		expect(attachments.get()?.controllerState).toBe("control_pending_abort_and_prompt");
	});

	test("cancel-and-steer callback without pending steer text is invalid", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		const reply = await gateway.handleUpdate(callback({ data: "gtr:v1:cancel-steer" }));
		expect(reply).toEqual({
			kind: "callback_answer",
			callbackAnswer: { text: MESSAGES.callbackInvalid },
			sendMessage: false,
		});
		expect(backend.countOf("abortAndPrompt")).toBe(0);
	});

	test("unauthorized callback refuses before consuming held text or enqueuing control", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.state = { ...backend.state, session: { status: "active", turnId: "old" } };
		const promptReply = await gateway.handleUpdate(message({ text: "do not leak" }));
		const reply = await gateway.handleUpdate(
			callback({ userId: "999", chatId: "999", data: buttonData(promptReply, "Steer") }),
		);
		expect(reply).toEqual({
			kind: "callback_answer",
			callbackAnswer: { text: MESSAGES.unauthorized },
			sendMessage: false,
		});
		expect(backend.countOf("steer")).toBe(0);
		expect(backend.countOf("abortAndPrompt")).toBe(0);
	});

	test("timeout replies immediately with queued while preserving in-flight input", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.prompt = async messageText => {
			backend.calls.push({ method: "prompt", args: messageText });
			await new Promise(() => undefined);
		};
		const reply = await gateway.handleUpdate(message({ text: "survive timeout" }));
		expect(reply).toEqual({ kind: "chat", text: "Queued." });
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["prompt", "survive timeout"]);
	});

	test("write failure replies reconnect and preserves queued input", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.prompt = async messageText => {
			backend.calls.push({ method: "prompt", args: messageText });
			throw new Error("write failed");
		};
		await gateway.handleUpdate(message({ text: "first" }));
		await Promise.resolve();
		const reply = await gateway.handleUpdate(message({ text: "second" }));
		expect(reply).toEqual({ kind: "chat", text: "Reconnecting to RPC session; input is queued." });
		expect(attachments.get()?.controllerState).toBe("reconnecting");
	});

	test("controller steal is visible and preserves queued input", async () => {
		const gateway = await makeGateway();
		await gateway.handleUpdate(message({ text: "/attach" }));
		backend.emitCommandIgnored(new Error("old controller command ignored"));
		const reply = await gateway.handleUpdate(message({ text: "preserved" }));
		expect(reply).toEqual({ kind: "chat", text: "Reconnecting to RPC session; input is queued." });
		expect(attachments.get()?.controllerState).toBe("reconnecting");
	});
	test("restorePersistedAttachment resumes persisted final-answer chunks without manual attach", async () => {
		const gateway = await makeGateway();
		const sent: Array<{ chatId: string; reply: { kind: string; text: string } }> = [];
		const resendGateway = new TelegramRpcGateway(
			{
				allowedUserIds: new Set(["100"]),
				allowedChatIds: new Set(["900"]),
				defaultSocketPath: "/tmp/gjc.sock",
				allowAttachSocketArg: false,
			},
			{
				backend,
				attachments,
				now: () => clock,
				outbound: {
					send: async message => {
						sent.push(message as { chatId: string; reply: { kind: string; text: string } });
						return { ok: true };
					},
				},
			},
		);
		void gateway;
		const raw = `${"x".repeat(4096)}tail`;
		backend.messages = [{ role: "assistant", content: raw, index: 4, timestamp: "t4" } as never];
		await attachments.set({
			chatId: "900",
			userId: "100",
			socketPath: "/tmp/gjc.sock",
			stale: false,
			pendingGateIds: [],
			deliveryIdentities: [],
			chunkProgress: {
				deliveryId: "message:4::t4:27805d0034d129596b35ac25fa14eb81",
				nextChunkIndex: 1,
				chunkCount: 2,
			},
			updatedAt: clock,
		});

		await resendGateway.restorePersistedAttachment();

		expect(sent.map(item => item.reply.text)).toEqual(["tail"]);
		expect(attachments.get()?.chunkProgress).toBeUndefined();
		expect(attachments.get()?.deliveryIdentities).toHaveLength(1);
	});

	test("restorePersistedAttachment fails closed when persisted binding is no longer authorized", async () => {
		const gateway = await makeGateway({ allowedUserIds: new Set(["100"]), allowedChatIds: new Set(["900"]) });
		const sent: Array<{ chatId: string; reply: { kind: string; text: string } }> = [];
		const restoreGateway = new TelegramRpcGateway(
			{
				allowedUserIds: new Set(["100"]),
				allowedChatIds: new Set(["900"]),
				defaultSocketPath: "/tmp/gjc.sock",
				allowAttachSocketArg: false,
			},
			{
				backend,
				attachments,
				now: () => clock,
				outbound: {
					send: async message => {
						sent.push(message as { chatId: string; reply: { kind: string; text: string } });
						return { ok: true };
					},
				},
			},
		);
		void gateway;
		await attachments.set({
			chatId: "not-allowed-chat",
			userId: "not-allowed-user",
			socketPath: "/tmp/restored.sock",
			stale: false,
			pendingGateIds: ["gate-1"],
			deliveryIdentities: [],
			updatedAt: clock,
		});

		await restoreGateway.restorePersistedAttachment();

		expect(backend.connectCalls).toBe(0);
		expect(sent).toHaveLength(0);
		expect(backend.countOf("getPendingWorkflowGates")).toBe(0);
	});
});
