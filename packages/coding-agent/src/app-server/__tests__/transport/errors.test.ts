import { expect, test } from "bun:test";
import { appServerError, goldenEnvelope, serializeError, serializeResult } from "../../transport/errors";

const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

test("goldenEnvelope: golden-backed codes come from the vendored authority with data omitted", () => {
	expect(goldenEnvelope("notInitialized")).toEqual({ code: -32600, message: "Not initialized" });
	expect(goldenEnvelope("alreadyInitialized")).toEqual({ code: -32600, message: "Already initialized" });
	expect(goldenEnvelope("overloaded")).toEqual({ code: -32001, message: "Server overloaded; retry later." });
	expect(goldenEnvelope("notSupported")).toEqual({ code: -32081, message: expect.any(String) });
});

test("goldenEnvelope: GJC-only keys are pinned and distinguishable from upstream goldens", () => {
	expect(goldenEnvelope("idempotencyConflict").code).toBe(-32013);
	expect(goldenEnvelope("audienceForbidden").code).toBe(-32014);
	expect(goldenEnvelope("busy").code).toBe(-32016);
});

test("goldenEnvelope: an unbacked key throws rather than emitting a placeholder", () => {
	expect(() => goldenEnvelope("bogus" as never)).toThrow(/unbacked app-server error key/);
});

test("serializeError: omits the data key, echoes the decoded id verbatim, appends newline on stdio only", () => {
	const ws = dec(serializeError(7, "invalidParams", "websocket")!) as Record<string, unknown>;
	expect(ws).toEqual({ id: 7, error: { code: -32602, message: expect.any(String) } });
	expect("data" in (ws.error as Record<string, unknown>)).toBe(false);

	const stdio = new TextDecoder().decode(serializeError("req-1", "methodNotFound", "stdio")!);
	expect(stdio.endsWith("\n")).toBe(true);
	const parsed = JSON.parse(stdio) as Record<string, unknown>;
	expect(parsed.id).toBe("req-1");
	expect((parsed.error as Record<string, unknown>).code).toBe(-32601);
});

test("serializeError: an undecoded stdio oversize frame echoes id null (data still omitted)", () => {
	const parsed = JSON.parse(new TextDecoder().decode(serializeError(null, "invalidRequest", "stdio")!)) as Record<string, unknown>;
	expect(parsed.id).toBe(null);
	expect((parsed.error as Record<string, unknown>).code).toBe(-32600);
	expect("data" in (parsed.error as Record<string, unknown>)).toBe(false);
});

test("serializeError: a notification (id undefined) gets no response", () => {
	expect(serializeError(undefined, "invalidRequest")).toBe(undefined);
});

test("appServerError: carries the typed cause internally without leaking it onto the wire", () => {
	const err = appServerError("internalError", { stack: "secret internals" });
	expect(err.code).toBe(-32603);
	expect(err.internal).toEqual({ stack: "secret internals" });
	const onWire = dec(serializeError(1, err.key)!) as Record<string, unknown>;
	expect("internal" in onWire).toBe(false);
	expect("data" in (onWire.error as Record<string, unknown>)).toBe(false);
});

test("serializeResult: result present, no error key, jsonrpc omitted", () => {
	const parsed = dec(serializeResult(3, { ok: true })!) as Record<string, unknown>;
	expect(parsed).toEqual({ id: 3, result: { ok: true } });
	expect("error" in parsed).toBe(false);
	expect("jsonrpc" in parsed).toBe(false);
});
