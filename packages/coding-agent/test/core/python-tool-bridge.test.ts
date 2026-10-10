import { afterAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@gajae-code/coding-agent/eval/py/tool-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";

interface FakeCall {
	id: string;
	args: unknown;
	signal?: AbortSignal;
}

function makeFakeTool(name: string, calls: FakeCall[], result: AgentToolResult): AgentTool {
	const tool = {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute(id: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
			calls.push({ id, args, signal });
			return result;
		},
	} as unknown as AgentTool;
	return tool;
}

function makeSession(tools: Map<string, AgentTool>): ToolSession {
	return { getToolByName: (name: string) => tools.get(name) } as unknown as ToolSession;
}

async function call(info: { url: string }, capability: string, body: Record<string, unknown>): Promise<Response> {
	return await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${capability}`,
		},
		body: JSON.stringify(body),
	});
}

describe("Python tool bridge HTTP server", () => {
	afterAll(async () => {
		await disposePyToolBridge();
	});

	it("dispatches calls to the registered ToolSession and returns the tool value", async () => {
		const calls: FakeCall[] = [];
		const readTool = makeFakeTool("read", calls, {
			content: [{ type: "text", text: "file body" }],
		});
		const session = makeSession(new Map([["read", readTool]]));
		const info = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const unregister = registerPyToolBridge("test-session-1", capability, { toolSession: session });
		try {
			const res = await call(info, capability, {
				session: "test-session-1",
				name: "read",
				args: { path: "foo.ts", _i: "py prelude" },
			});
			const body = await res.json();
			expect(res.status).toBe(200);
			expect(body).toEqual({ ok: true, value: "file body" });
			expect(calls).toHaveLength(1);
			// `_i` survives the bridge round trip so transcript renderers have a label.
			expect((calls[0]!.args as { _i?: string })._i).toBe("py prelude");
		} finally {
			unregister();
		}
	});

	it("does not dispatch a body that finishes after unregister or abort", async () => {
		const calls: FakeCall[] = [];
		const readTool = makeFakeTool("read", calls, { content: [{ type: "text", text: "x" }] });
		const session = makeSession(new Map([["read", readTool]]));
		const info = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const controller = new AbortController();
		const unregister = registerPyToolBridge("stale-session", capability, {
			toolSession: session,
			signal: controller.signal,
		});
		const encoder = new TextEncoder();
		const payload = JSON.stringify({ session: "stale-session", name: "read", args: {} });
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				controller.enqueue(encoder.encode(payload.slice(0, 2)));
				await gate;
				controller.enqueue(encoder.encode(payload.slice(2)));
				controller.close();
			},
		});
		const pending = fetch(`${info.url}/v1/tool`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${capability}`,
			},
			body,
			duplex: "half",
		});
		await Bun.sleep(30);
		unregister();
		controller.abort();
		release();
		const res = await pending;
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("rejects an unregistered capability", async () => {
		const info = await ensurePyToolBridge();
		const res = await call(info, crypto.randomUUID(), { session: "missing", name: "read", args: {} });
		expect(res.status).toBe(403);
	});

	it("surfaces tool errors as ok=false with the error message", async () => {
		const session = {
			getToolByName: (_: string) =>
				({
					name: "boom",
					label: "boom",
					description: "boom",
					parameters: { type: "object" },
					async execute(): Promise<AgentToolResult> {
						throw new Error("kapow");
					},
				}) as unknown as AgentTool,
		} as unknown as ToolSession;
		const info = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const unregister = registerPyToolBridge("err-session", capability, { toolSession: session });
		try {
			const res = await call(info, capability, { session: "err-session", name: "boom", args: {} });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ ok: false, error: "kapow" });
		} finally {
			unregister();
		}
	});

	it("rejects requests with a bad bearer token", async () => {
		const info = await ensurePyToolBridge();
		const res = await call(info, "wrong", { session: "anything", name: "read", args: {} });
		expect(res.status).toBe(403);
	});

	it("rejects missing, empty, and whitespace bearer credentials before lookup", async () => {
		const info = await ensurePyToolBridge();
		for (const authorization of [null, "Bearer ", "Bearer    ", "Bearer invalid capability"]) {
			const headers = new Headers({ "Content-Type": "application/json" });
			if (authorization !== null) headers.set("Authorization", authorization);
			const res = await fetch(`${info.url}/v1/tool`, {
				method: "POST",
				headers,
				body: JSON.stringify({ session: "anything", name: "read", args: {} }),
			});
			expect(res.status).toBe(403);
		}
	});

	it("rejects empty and whitespace registration capabilities", () => {
		const session = makeSession(new Map());
		for (const capability of ["", " ", "\t", "invalid capability"]) {
			expect(() => registerPyToolBridge("invalid-registration", capability, { toolSession: session })).toThrow(
				"canonical bearer token",
			);
		}
	});

	it("returns 400 when body is missing required fields", async () => {
		const info = await ensurePyToolBridge();
		const capability = crypto.randomUUID();
		const unregister = registerPyToolBridge("validation-session", capability, {
			toolSession: makeSession(new Map()),
		});
		try {
			const res = await call(info, capability, { name: "read" });
			expect(res.status).toBe(400);
		} finally {
			unregister();
		}
	});

	it("authenticates before parsing the request body", async () => {
		const info = await ensurePyToolBridge();
		const res = await fetch(`${info.url}/v1/tool`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
			body: "not-json",
		});
		expect(res.status).toBe(403);
	});

	it("does not let one session capability select another registered session", async () => {
		const callsA: FakeCall[] = [];
		const callsB: FakeCall[] = [];
		const capabilityA = crypto.randomUUID();
		const capabilityB = crypto.randomUUID();
		const info = await ensurePyToolBridge();
		const unregisterA = registerPyToolBridge("session-a", capabilityA, {
			toolSession: makeSession(
				new Map([["read", makeFakeTool("read", callsA, { content: [{ type: "text", text: "A" }] })]]),
			),
		});
		const unregisterB = registerPyToolBridge("session-b", capabilityB, {
			toolSession: makeSession(
				new Map([["read", makeFakeTool("read", callsB, { content: [{ type: "text", text: "B" }] })]]),
			),
		});
		try {
			const crossSession = await call(info, capabilityA, { session: "session-b", name: "read", args: {} });
			expect(crossSession.status).toBe(403);
			expect(callsA).toHaveLength(0);
			expect(callsB).toHaveLength(0);

			const ownSession = await call(info, capabilityB, { session: "session-b", name: "read", args: {} });
			expect(ownSession.status).toBe(200);
			expect(await ownSession.json()).toEqual({ ok: true, value: "B" });
			expect(callsB).toHaveLength(1);
		} finally {
			unregisterA();
			unregisterB();
		}
	});

	it("invalidates unregistered capabilities and accepts a rotated capability", async () => {
		const calls: FakeCall[] = [];
		const session = makeSession(
			new Map([["read", makeFakeTool("read", calls, { content: [{ type: "text", text: "ok" }] })]]),
		);
		const info = await ensurePyToolBridge();
		const staleCapability = crypto.randomUUID();
		const unregisterStale = registerPyToolBridge("rotation-session", staleCapability, { toolSession: session });
		unregisterStale();

		const rotatedCapability = crypto.randomUUID();
		const unregisterRotated = registerPyToolBridge("rotation-session", rotatedCapability, {
			toolSession: session,
		});
		try {
			const stale = await call(info, staleCapability, {
				session: "rotation-session",
				name: "read",
				args: {},
			});
			expect(stale.status).toBe(403);

			const rotated = await call(info, rotatedCapability, {
				session: "rotation-session",
				name: "read",
				args: {},
			});
			expect(rotated.status).toBe(200);
			expect(calls).toHaveLength(1);
		} finally {
			unregisterRotated();
		}
	});

	it("invokes emitStatus alongside the tool result", async () => {
		const calls: FakeCall[] = [];
		const readTool = makeFakeTool("read", calls, {
			content: [{ type: "text", text: "abc" }],
		});
		const session = makeSession(new Map([["read", readTool]]));
		const info = await ensurePyToolBridge();
		const statusEvents: Array<{ op: string }> = [];
		const capability = crypto.randomUUID();
		const unregister = registerPyToolBridge("status-session", capability, {
			toolSession: session,
			emitStatus: event => statusEvents.push(event),
		});
		try {
			const res = await call(info, capability, {
				session: "status-session",
				name: "read",
				args: { path: "foo.ts" },
			});
			expect(res.status).toBe(200);
			expect(statusEvents).toHaveLength(1);
			expect(statusEvents[0]!.op).toBe("read");
		} finally {
			unregister();
		}
	});
});
