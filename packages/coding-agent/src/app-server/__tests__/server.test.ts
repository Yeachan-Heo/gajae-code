import { expect, test } from "bun:test";
import { processInbound } from "../server";
import { ConnectionState } from "../router/connection-state";
import { ThreadRuntimeManager } from "../thread-runtime/thread-runtime-manager";
import { decodeLine } from "../transport/framing";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>) : undefined);
const state = () => new ConnectionState();
const mgr = () => new ThreadRuntimeManager();

test("server: oversize stdio frame returns GJC-only -32600 id null", () => {
	const huge = "x".repeat(5 * 1024 * 1024);
	const result = processInbound(state(), mgr(), enc(huge), { maxFrameBytes: 1024 }, "stdio");
	const parsed = dec(result.response)!;
	expect(parsed.id).toBe(null);
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
});

test("server: malformed JSON is silently dropped (no response)", () => {
	const result = processInbound(state(), mgr(), enc("{not json"));
	expect(result.response).toBeUndefined();
	expect(result.notification).toBeUndefined();
});

test("server: request before initialize returns Not initialized", () => {
	const result = processInbound(state(), mgr(), enc('{"id":1,"method":"thread/start"}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
	expect((parsed.error as Record<string, unknown>).message).toBe("Not initialized");
});

test("server: initialize handshake then thread/start is notSupported (no handler wired yet)", () => {
	const s = state();
	// First: initialize
	const initResult = processInbound(s, mgr(), enc('{"id":1,"method":"initialize","params":{}}'));
	expect(dec(initResult.response)).toBeDefined();
	// initialized notification
	processInbound(s, mgr(), enc('{"method":"initialized"}'));
	// thread/start generates a threadId server-side and registers as spawned.
	const myMgr = mgr();
	const result = processInbound(s, myMgr, enc('{"id":2,"method":"thread/start","params":{}}'));
	const parsed = dec(result.response)!;
	expect((parsed.result as Record<string, unknown>).status).toBe("loaded");
	expect((parsed.result as Record<string, unknown>).threadId).toEqual(expect.any(String));
	const startedThreadId = (parsed.result as Record<string, unknown>).threadId as string;
	expect(myMgr.get(startedThreadId)?.ownership).toBe("spawned");
	// thread/resume registers as attached with the provided threadId.
	const resumeResult = processInbound(s, myMgr, enc('{"id":3,"method":"thread/resume","params":{"threadId":"resumed-thread"}}'));
	const resumeParsed = dec(resumeResult.response)!;
	expect((resumeParsed.result as Record<string, unknown>).threadId).toBe("resumed-thread");
	expect(myMgr.get("resumed-thread")?.ownership).toBe("attached");
	// thread/fork registers as spawned with the provided threadId.
	const forkResult = processInbound(s, myMgr, enc('{"id":4,"method":"thread/fork","params":{"threadId":"forked-thread"}}'));
	const forkParsed = dec(forkResult.response)!;
	expect((forkParsed.result as Record<string, unknown>).threadId).toBe("forked-thread");
	expect(myMgr.get("forked-thread")?.ownership).toBe("spawned");
});

test("server: duplicate initialize returns Already initialized", () => {
	const s = state();
	processInbound(s, mgr(), enc('{"id":1,"method":"initialize","params":{}}'));
	processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = processInbound(s, mgr(), enc('{"id":2,"method":"initialize","params":{}}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).message).toBe("Already initialized");
});

test("server: unknown method returns method not found", () => {
	const s = state();
	processInbound(s, mgr(), enc('{"id":1,"method":"initialize","params":{}}'));
	processInbound(s, mgr(), enc('{"method":"initialized"}'));
	const result = processInbound(s, mgr(), enc('{"id":2,"method":"fabricated/method"}'));
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32601);
});

test("server: notification is consumed silently", () => {
	const s = state();
	processInbound(s, mgr(), enc('{"id":1,"method":"initialize","params":{}}'));
	const result = processInbound(s, mgr(), enc('{"method":"initialized"}'));
	expect(result.response).toBeUndefined();
	expect(result.notification).toBe(true);
});

test("server: jsonrpc header is stripped and not echoed back", () => {
	const s = state();
	const result = processInbound(s, mgr(), enc('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'));
	const text = new TextDecoder().decode(result.response!);
	expect(text).not.toContain("jsonrpc");
});
