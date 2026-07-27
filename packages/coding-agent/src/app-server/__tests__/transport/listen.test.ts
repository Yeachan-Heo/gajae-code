import { expect, test } from "bun:test";
import { exposesTransport, isLoopback, needsHealthProbes, parseListenUrl } from "../../transport/listen";

test("parseListenUrl: undefined defaults to stdio", () => {
	expect(parseListenUrl(undefined)).toEqual({ kind: "stdio" });
});

test("parseListenUrl: stdio shorthand", () => {
	expect(parseListenUrl("stdio")).toEqual({ kind: "stdio" });
	expect(parseListenUrl("stdio://")).toEqual({ kind: "stdio" });
});

test("parseListenUrl: ws://IP:PORT", () => {
	expect(parseListenUrl("ws://127.0.0.1:8080")).toEqual({ kind: "ws", host: "127.0.0.1", port: 8080 });
	expect(parseListenUrl("ws://0.0.0.0:3000")).toEqual({ kind: "ws", host: "0.0.0.0", port: 3000 });
});

test("parseListenUrl: ws:// without port throws", () => {
	expect(() => parseListenUrl("ws://127.0.0.1")).toThrow(/port/);
});

test("parseListenUrl: ws:// with invalid port throws", () => {
	expect(() => parseListenUrl("ws://127.0.0.1:abc")).toThrow(/port/);
	expect(() => parseListenUrl("ws://127.0.0.1:0")).toThrow(/port/);
	expect(() => parseListenUrl("ws://127.0.0.1:99999")).toThrow(/port/);
});

test("parseListenUrl: unix:// with explicit path", () => {
	expect(parseListenUrl("unix:///tmp/app.sock")).toEqual({ kind: "unix", path: "/tmp/app.sock" });
});

test("parseListenUrl: unix:// with default path (null)", () => {
	expect(parseListenUrl("unix://")).toEqual({ kind: "unix", path: null });
});

test("parseListenUrl: off is valid standalone mode", () => {
	expect(parseListenUrl("off")).toEqual({ kind: "off" });
});

test("parseListenUrl: unsupported URL throws", () => {
	expect(() => parseListenUrl("http://example.com")).toThrow(/unsupported/);
	expect(() => parseListenUrl("tcp://localhost:8080")).toThrow(/unsupported/);
});

test("needsHealthProbes: true for ws and unix, false for stdio and off", () => {
	expect(needsHealthProbes(parseListenUrl("ws://127.0.0.1:8080"))).toBe(true);
	expect(needsHealthProbes(parseListenUrl("unix:///tmp/s.sock"))).toBe(true);
	expect(needsHealthProbes(parseListenUrl("stdio"))).toBe(false);
	expect(needsHealthProbes(parseListenUrl("off"))).toBe(false);
});

test("exposesTransport: false for off, true for everything else", () => {
	expect(exposesTransport(parseListenUrl("off"))).toBe(false);
	expect(exposesTransport(parseListenUrl("stdio"))).toBe(true);
	expect(exposesTransport(parseListenUrl("ws://127.0.0.1:8080"))).toBe(true);
	expect(exposesTransport(parseListenUrl("unix:///tmp/s.sock"))).toBe(true);
});

test("isLoopback: 127.0.0.1 and localhost are loopback; 0.0.0.0 is not", () => {
	expect(isLoopback(parseListenUrl("ws://127.0.0.1:8080"))).toBe(true);
	expect(isLoopback(parseListenUrl("ws://localhost:8080"))).toBe(true);
	expect(isLoopback(parseListenUrl("ws://0.0.0.0:8080"))).toBe(false);
	expect(isLoopback(parseListenUrl("stdio"))).toBe(true);
	expect(isLoopback(parseListenUrl("off"))).toBe(true);
});
