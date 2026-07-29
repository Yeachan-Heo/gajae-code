import { expect, test } from "bun:test";
import { ConnectionState } from "../../router/connection-state";
import { type InboundContext, processInbound } from "../../server";
import { ServerRequestBroker, type ServerRequestHandle } from "../../server-requests/broker";
import { ThreadSubscriptionIndex } from "../../subscriptions";
import { HandlerRegistry } from "../../suites/handlers";
import {
	type EndpointAuthority,
	type ManagedThread,
	type ThreadOwnership,
	ThreadRuntimeManager,
} from "../../thread-runtime/thread-runtime-manager";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class CountingManager extends ThreadRuntimeManager {
	registrations = 0;

	override register(
		threadId: string,
		ownership: ThreadOwnership,
		authority: EndpointAuthority | undefined,
		connectionId?: string,
	): ManagedThread {
		this.registrations++;
		return super.register(threadId, ownership, authority, connectionId);
	}
}

class CountingBroker extends ServerRequestBroker {
	creates = 0;

	override create(
		id: string,
		method: string,
		params: unknown,
		threadId: string,
		eligibleConnections: Set<string>,
	): ServerRequestHandle | undefined {
		this.creates++;
		return super.create(id, method, params, threadId, eligibleConnections);
	}
}

interface Counters {
	registrations: number;
	subscriptions: number;
	approvalEmissions: number;
}

interface Fixture {
	state: ConnectionState;
	manager: CountingManager;
	broker: CountingBroker;
	registry: HandlerRegistry;
	context: InboundContext;
	counters: () => Counters;
}

function request(id: number, method: string, params: unknown): Uint8Array {
	return encoder.encode(JSON.stringify({ id, method, params }));
}

function response(frame: Uint8Array | undefined): Record<string, unknown> {
	if (!frame) throw new Error("expected a JSON-RPC response");
	return JSON.parse(decoder.decode(frame)) as Record<string, unknown>;
}

async function initialize(fixture: Fixture): Promise<void> {
	await processInbound(
		fixture.state,
		fixture.manager,
		request(1, "initialize", { clientInfo: { name: "test", version: "1" } }),
		undefined,
		"websocket",
		fixture.registry,
		fixture.context,
	);
	await processInbound(
		fixture.state,
		fixture.manager,
		encoder.encode('{"method":"initialized"}'),
		undefined,
		"websocket",
		fixture.registry,
		fixture.context,
	);
}

function fixture(): Fixture {
	const manager = new CountingManager();
	const broker = new CountingBroker();
	const registry = new HandlerRegistry();
	const subscriptions = new ThreadSubscriptionIndex();
	const context: InboundContext = {
		connectionId: "connection-test",
		broker,
		subscribe: threadId => subscriptions.subscribe("connection-test", threadId),
		requestClient: (threadId, method, params) => {
			const request = broker.create("approval-1", method, params, threadId, new Set(["connection-test"]));
			return request?.id;
		},
	};
	registry.register("config/read", (_params, handlerContext) => {
		handlerContext?.requestClient?.("thread-1", "execCommandApproval", { command: "pwd" });
		return { ok: true, result: { config: {}, origins: {} } };
	});
	return {
		state: new ConnectionState(),
		manager,
		broker,
		registry,
		context,
		counters: () => ({
			registrations: manager.registrations,
			subscriptions: subscriptions.subscribedThreads,
			approvalEmissions: broker.creates,
		}),
	};
}

function expectInvalidParams(envelope: Record<string, unknown>, id: number): void {
	expect(envelope).toEqual({ id, error: { code: -32602, message: "Invalid params" } });
	expect(Object.hasOwn(envelope.error as object, "data")).toBe(false);
}

test("validation boundary: valid implemented requests prove approval effects fire", async () => {
	const f = fixture();
	await initialize(f);
	const configRead = response(
		await processInbound(
			f.state,
			f.manager,
			request(3, "config/read", {}),
			undefined,
			"websocket",
			f.registry,
			f.context,
		).then(result => result.response),
	);
	// The stub config/read handler exists only to fire requestClient, but outbound results are
	// now validated against the vendored schema, so it must still return a conforming shape.
	expect(configRead).toEqual({ id: 3, result: { config: {}, origins: {} } });
	expect(f.counters()).toEqual({ registrations: 0, subscriptions: 0, approvalEmissions: 1 });
	expect(f.broker.pendingCount).toBe(1);
});

test("validation boundary: malformed implemented payloads return -32602 before approval effects", async () => {
	const malformed = [
		["wrong path type", "fs/readFile", { path: 1 }],
		["wrong base64 type", "fs/writeFile", { path: "/workspace/file", dataBase64: 1 }],
	] as const;

	for (const [name, method, params] of malformed) {
		const f = fixture();
		await initialize(f);
		const result = await processInbound(
			f.state,
			f.manager,
			request(2, method, params),
			undefined,
			"websocket",
			f.registry,
			f.context,
		);
		expectInvalidParams(response(result.response), 2);
		expect(f.counters(), name).toEqual({ registrations: 0, subscriptions: 0, approvalEmissions: 0 });
		expect(f.broker.pendingCount, name).toBe(0);
	}
});

test("validation boundary: handshake and experimental gates win over malformed params", async () => {
	const uninitialized = fixture();
	const beforeInitialize = await processInbound(
		uninitialized.state,
		uninitialized.manager,
		request(2, "thread/start", {
			approvalPolicy: { granular: { mcp_elicitations: "true", rules: true, sandbox_approval: true } },
		}),
		undefined,
		"websocket",
		uninitialized.registry,
		uninitialized.context,
	);
	expect(response(beforeInitialize.response)).toEqual({ id: 2, error: { code: -32600, message: "Not initialized" } });
	expect(uninitialized.counters()).toEqual({ registrations: 0, subscriptions: 0, approvalEmissions: 0 });

	const stable = fixture();
	await initialize(stable);
	const experimental = await processInbound(
		stable.state,
		stable.manager,
		request(2, "fuzzyFileSearch/sessionStart", { sessionId: 1 }),
		undefined,
		"websocket",
		stable.registry,
		stable.context,
	);
	expect(response(experimental.response)).toEqual({ id: 2, error: { code: -32081, message: "Not supported" } });
	expect(stable.counters()).toEqual({ registrations: 0, subscriptions: 0, approvalEmissions: 0 });
});
