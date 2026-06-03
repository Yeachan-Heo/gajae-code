import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	ControlServer,
	callEndpoint,
	type EndpointRequest,
	EndpointUnreachableError,
} from "../../src/harness-control-plane/control-endpoint";

let dir: string;
let sock: string;
let server: ControlServer | null = null;

beforeEach(async () => {
	// Keep the socket path short (AF_UNIX sun_path limit) by living directly in a temp dir.
	dir = await mkdtemp(path.join(tmpdir(), "h-ep-"));
	sock = path.join(dir, "c.sock");
	server = null;
});

afterEach(async () => {
	await server?.close();
	await rm(dir, { recursive: true, force: true });
});

describe("control endpoint", () => {
	it("round-trips a request to the owner handler and back", async () => {
		const seen: EndpointRequest[] = [];
		server = new ControlServer(sock, async req => {
			seen.push(req);
			return { ok: true, echoed: req.verb, n: (req.input.n as number) + 1 };
		});
		await server.listen();
		const res = (await callEndpoint(sock, { verb: "submit", input: { n: 41 } })) as Record<string, unknown>;
		expect(res.ok).toBe(true);
		expect(res.echoed).toBe("submit");
		expect(res.n).toBe(42);
		expect(seen).toHaveLength(1);
		expect(seen[0].verb).toBe("submit");
	});

	it("surfaces handler errors as a structured failure, not a crash", async () => {
		server = new ControlServer(sock, async () => {
			throw new Error("boom-in-owner");
		});
		await server.listen();
		const res = (await callEndpoint(sock, { verb: "recover", input: {} })) as Record<string, unknown>;
		expect(res.ok).toBe(false);
		expect(String(res.error)).toContain("boom-in-owner");
	});

	it("rejects with EndpointUnreachableError when no owner is listening", async () => {
		await expect(callEndpoint(path.join(dir, "absent.sock"), { verb: "submit", input: {} })).rejects.toBeInstanceOf(
			EndpointUnreachableError,
		);
	});

	it("serves multiple sequential calls on the same socket", async () => {
		let count = 0;
		server = new ControlServer(sock, async () => ({ ok: true, count: ++count }));
		await server.listen();
		const a = (await callEndpoint(sock, { verb: "observe", input: {} })) as Record<string, unknown>;
		const b = (await callEndpoint(sock, { verb: "observe", input: {} })) as Record<string, unknown>;
		expect(a.count).toBe(1);
		expect(b.count).toBe(2);
	});
});
