import { expect, test } from "bun:test";
import { ConnectionState } from "../router/connection-state";
import { classifyInbound } from "../router/dispatch";
import { processInbound } from "../server";
import { ThreadRuntimeManager } from "../thread-runtime/thread-runtime-manager";
import { coerceId } from "../transport/framing";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
	b ? (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>) : undefined;
const state = () => new ConnectionState();
const mgr = () => new ThreadRuntimeManager();

test("server: oversize stdio frame returns GJC-only -32600 id null", async () => {
	const huge = "x".repeat(5 * 1024 * 1024);
	const result = await processInbound(state(), mgr(), enc(huge), { maxFrameBytes: 1024 }, "stdio");
	const parsed = dec(result.response)!;
	expect(parsed.id).toBe(null);
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
});

test("server: malformed JSON is silently dropped with an explicit malformed rejection disposition", async () => {
	const result = await processInbound(state(), mgr(), enc("{not json"));
	expect(result).toEqual({ rejected: "malformed" });
});

test("server: oversize websocket and unix frames are dropped with an explicit oversize rejection disposition", async () => {
	const huge = enc("x".repeat(1025));
	await expect(processInbound(state(), mgr(), huge, { maxFrameBytes: 1024 }, "websocket")).resolves.toEqual({
		rejected: "oversize",
	});
	await expect(processInbound(state(), mgr(), huge, { maxFrameBytes: 1024 }, "unix")).resolves.toEqual({
		rejected: "oversize",
	});
});

test("server: request before initialize returns Not initialized", async () => {
	const result = await processInbound(state(), mgr(), enc('{"id":1,"method":"thread/start"}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
	expect((parsed.error as Record<string, unknown>).message).toBe("Not initialized");
});

test("server: a planned thread method is not supported after the handshake", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = await processInbound(s, mgr(), enc('{"id":2,"method":"thread/start","params":{}}'));
	expect((dec(result.response)!.error as Record<string, unknown>).code).toBe(-32081);
});

test("server: malformed initialize params return -32602 without mutating capabilities", async () => {
	const s = state();
	const result = await processInbound(
		s,
		mgr(),
		enc(
			'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test"},"capabilities":{"experimentalApi":true}}}',
		),
	);
	expect(dec(result.response)).toEqual({ id: 1, error: { code: -32602, message: "Invalid params" } });
	expect(s.stage).toBe("uninitialized");
	expect(s.capabilities).toBeUndefined();
});

test("server: malformed initialized notification is consumed without completing the handshake", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	const result = await processInbound(s, mgr(), enc('{"method":"initialized","params":{}}'));
	expect(result).toEqual({ notification: true });
	expect(s.stage).toBe("initializing");
	expect(s.initialized).toBe(false);
});

test("server: duplicate initialize returns Already initialized", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = await processInbound(
		s,
		mgr(),
		enc('{"id":2,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0.0"}}}'),
	);
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).message).toBe("Already initialized");
});

test("server: unknown method returns method not found", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = await processInbound(s, mgr(), enc('{"id":2,"method":"fabricated/method"}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32601);
});

test("server: notification is consumed silently", async () => {
	const s = state();
	await processInbound(
		s,
		mgr(),
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	const result = await processInbound(s, mgr(), enc('{"method":"initialized"}'));
	expect(result.response).toBeUndefined();
	expect(result.notification).toBe(true);
});

test("server: jsonrpc header is stripped and not echoed back", async () => {
	const s = state();
	const result = await processInbound(
		s,
		mgr(),
		enc('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	const text = new TextDecoder().decode(result.response!);
	expect(text).not.toContain("jsonrpc");
});

test("server: invalid numeric ids return -32600 before initialize and string and integer ids succeed", async () => {
	const invalidIds = ["1.5", "-0", "9007199254740992"];
	for (const id of invalidIds) {
		const s = state();
		const result = await processInbound(
			s,
			mgr(),
			enc(`{"id":${id},"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}`),
		);
		expect((dec(result.response)!.error as Record<string, unknown>).code, id).toBe(-32600);
		expect(s.stage, id).toBe("uninitialized");
	}

	for (const id of ['"string-id"', "1"]) {
		const s = state();
		const result = await processInbound(
			s,
			mgr(),
			enc(`{"id":${id},"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}`),
		);
		expect(dec(result.response), id).toHaveProperty("result");
		expect(s.stage, id).toBe("initializing");
	}
});

test("server: non-finite JavaScript numeric ids are invalid", () => {
	for (const id of [Number.NaN, Number.POSITIVE_INFINITY]) {
		const classification = classifyInbound({ id, method: "initialize" }, coerceId(id));
		expect(classification.direction).toBe("invalid");
	}
});

test("server: response frames carrying both or neither result and error are invalid requests", async () => {
	for (const frame of [
		'{"id":"server-1"}',
		'{"id":"server-1","result":{},"error":{"code":-32603,"message":"Internal error"}}',
	]) {
		const result = await processInbound(state(), mgr(), enc(frame));
		expect((dec(result.response)!.error as Record<string, unknown>).code).toBe(-32600);
	}
});
