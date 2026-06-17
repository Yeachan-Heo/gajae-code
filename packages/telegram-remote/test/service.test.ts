import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../src/config";
import { MESSAGES, UNAUTHORIZED_REFUSAL } from "../src/messages";
import { RpcAttachmentStore } from "../src/rpc-attachment-store";
import { FakeRpcBackend } from "../src/rpc-backend";
import { runService } from "../src/service";
import type { CoordinationStatus, IncomingUpdate } from "../src/types";
import { FakeCoordinatorClient, FakeTransport, message, preset, presetMap } from "./helpers";

function serviceConfig(overrides: Partial<ServiceConfig["policy"]> = {}): ServiceConfig {
	return {
		botToken: "x",
		pollTimeoutSec: 1,
		enableEditMessageText: false,
		registerBotCommands: false,
		followTtlMs: 86_400_000,
		enablePush: false,
		subscriptionsMax: 1000,
		longPollMs: 1,
		digestThreshold: 5,
		policy: {
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: presetMap(preset()),
			enableStop: true,
			...overrides,
		},
		backend: "coordinator",
		coordinator: { command: "gjc", args: ["mcp-serve", "coordinator"], env: {} },
	};
}

function liveStatus(): CoordinationStatus {
	return {
		ok: true,
		sessions: [{ session_id: "sess-1", branch: "main" }],
		sessionStates: [{ session_id: "sess-1", state: "running", live: true }],
		turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1" }],
	};
}

describe("runService end-to-end (fake transport + fake coordinator)", () => {
	test("plain mode drives the command loop and replies per the contract", async () => {
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = liveStatus();

		const inbox: IncomingUpdate[] = [
			{ kind: "message", userId: "100", chatId: "100", text: "/help" },
			{ kind: "message", userId: "100", chatId: "100", text: "/sessions" },
			{ kind: "message", userId: "100", chatId: "100", text: "/start-session demo build it" },
			{ kind: "message", userId: "666", chatId: "666", text: "/sessions" },
		];
		const transport = new FakeTransport(inbox);

		await runService(serviceConfig({ enableRichMessages: false }), { coordinator, transport });

		expect(transport.sent[0]?.text).toBe(MESSAGES.help);
		expect(transport.sent[1]?.text).toContain("sess-1");
		expect(transport.sent[2]?.text).toContain("sess-1");
		expect(transport.sent[3]?.text).toBe(UNAUTHORIZED_REFUSAL);
		// Plain mode: no parse mode or inline keyboard.
		const sessionsReply = transport.sent[1]?.reply;
		expect(typeof sessionsReply === "object" && sessionsReply.kind === "chat" && sessionsReply.parseMode).toBeFalsy();
		expect(coordinator.countOf("startSession")).toBe(1);
	});

	test("rich mode returns an HTML reply with an inline keyboard for /sessions", async () => {
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = liveStatus();
		const transport = new FakeTransport([{ kind: "message", userId: "100", chatId: "100", text: "/sessions" }]);

		await runService(serviceConfig({ enableRichMessages: true }), { coordinator, transport });

		const reply = transport.sent[0]?.reply;
		expect(typeof reply === "object" && reply.kind === "chat").toBe(true);
		if (typeof reply === "object" && reply.kind === "chat") {
			expect(reply.parseMode).toBe("HTML");
			// Browsing UX: at least one session row plus the Live/Blocked/Done/All filter row.
			const keyboard = reply.replyMarkup?.inline_keyboard ?? [];
			expect(keyboard.length).toBeGreaterThanOrEqual(2);
			expect(keyboard.flat().some(b => b.text === "live" || b.text === "[all]")).toBe(true);
			expect(reply.text).toContain("<code>");
		}
	});
});

test("push disabled by default exposes no Follow buttons and starts no notifier", async () => {
	const coordinator = new FakeCoordinatorClient();
	coordinator.status = liveStatus();
	const transport = new FakeTransport([message({ text: "/sessions" })]);
	await runService(serviceConfig({ enableRichMessages: true }), { coordinator, transport });
	expect(transport.sent[0]?.text).not.toContain("Follow");
	expect(transport.outbound).toHaveLength(0);
	expect(coordinator.countOf("watchEvents")).toBe(0);
});

test("push enabled without stateDir fails safe: no notifier and no Follow buttons", async () => {
	const coordinator = new FakeCoordinatorClient();
	coordinator.status = liveStatus();
	const transport = new FakeTransport([message({ text: "/sessions" })]);
	await runService({ ...serviceConfig({ enableRichMessages: true }), enablePush: true }, { coordinator, transport });
	expect(transport.sent[0]?.text).not.toContain("Follow");
	expect(coordinator.countOf("watchEvents")).toBe(0);
});

test("push enabled with stateDir starts notifier", async () => {
	const coordinator = new FakeCoordinatorClient();
	coordinator.status = liveStatus();
	coordinator.watchScript = [{ ok: true, events: [], latestSeq: 0, timedOut: true }];
	const transport = new FakeTransport([]);
	const stateDir = await mkdtemp(join(tmpdir(), "gtr-service-"));
	await runService(
		{ ...serviceConfig({ enableRichMessages: true }), enablePush: true, stateDir },
		{ coordinator, transport },
	);
	expect(coordinator.countOf("watchEvents")).toBeGreaterThan(0);
});

test("RPC mode does not instantiate or browse the coordinator", async () => {
	class ThrowingCoordinator extends FakeCoordinatorClient {
		override async getCoordinationStatus(): Promise<CoordinationStatus> {
			throw new Error("coordinator_should_not_be_called");
		}
	}
	const coordinator = new ThrowingCoordinator();
	const rpcBackend = new FakeRpcBackend("/tmp/gjc.sock");
	const transport = new FakeTransport([message({ text: "/sessions" }), message({ text: "/status" })]);
	const stateDir = await mkdtemp(join(tmpdir(), "gtr-rpc-service-"));
	await runService(
		{
			...serviceConfig({ enableRichMessages: true }),
			backend: "rpc",
			stateDir,
			rpc: { socketPath: "/tmp/gjc.sock", stateDir, livenessMs: 60_000, allowAttachSocketArg: false },
		},
		{ coordinator, rpcBackend, transport },
	);
	expect(transport.sent[0]?.text).toBe(MESSAGES.unknownCommand);
	expect(transport.sent[1]?.text).toBe("Detached.");
	expect(coordinator.calls).toHaveLength(0);
	expect(rpcBackend.connectCalls).toBe(0);
});

test("RPC mode restores persisted attachment and replays pending gate on startup", async () => {
	const rpcBackend = new FakeRpcBackend("/tmp/default.sock");
	rpcBackend.pendingWorkflowGates = [
		{
			type: "workflow_gate",
			gate_id: "gate-1",
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string" },
			schema_hash: "hash",
			options: [{ label: "Approve", value: "approve" }],
			context: { title: "Approve?", prompt: "Approve restored gate?" },
			created_at: "2026-06-16T00:00:00Z",
			required: true,
		},
	];
	const transport = new FakeTransport([]);
	const stateDir = await mkdtemp(join(tmpdir(), "gtr-rpc-service-restore-"));
	const store = await RpcAttachmentStore.open({ stateDir });
	await store.set({
		chatId: "100",
		userId: "100",
		socketPath: "/tmp/restored.sock",
		stale: false,
		controllerState: "attached_idle",
		pendingGateIds: ["gate-1"],
		deliveryIdentities: [],
		updatedAt: 1,
	});

	await runService(
		{
			...serviceConfig({ enableRichMessages: true }),
			backend: "rpc",
			stateDir,
			rpc: { socketPath: "/tmp/default.sock", stateDir, livenessMs: 60_000, allowAttachSocketArg: false },
		},
		{ rpcBackend, transport },
	);

	expect(rpcBackend.calls).toContainEqual({ method: "connect", args: "/tmp/restored.sock" });
	expect(rpcBackend.countOf("getPendingWorkflowGates")).toBe(2);
	expect(transport.outbound).toHaveLength(1);
	expect(transport.outbound[0].chatId).toBe("100");
	expect(transport.outbound[0].reply.text).toContain("Approve restored gate?");
});
