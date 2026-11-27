import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionSdkHost } from "../src/sdk/host/host";
import { createTestSession } from "./utilities";

for (const fault of ["written", "dropped", "rejected", "before-hook"] as const) {
	test(`accepted idle close disposes after ${fault} response delivery`, async () => {
		const { session, cleanup } = await createTestSession({ inMemory: true });
		let receive!: (connection: string, frame: Record<string, unknown>) => void;
		let shutdown = false;
		let afterResponseCalls = 0;
		const host = new SessionSdkHost({
			sessionId: session.sessionId,
			stateRoot: "/tmp/idle-close-delivery",
			token: "fixture-token",
			onFrame(handler) {
				receive = handler;
				return () => {};
			},
			sendFrame(_connection, frame) {
				if (frame.type !== "control_response") return "written";
				if (fault === "rejected") throw new Error("write rejected");
				return fault === "written" ? "written" : "dropped";
			},
			beforeControlResponse() {
				if (fault === "before-hook") throw new Error("before response failed");
			},
			control() {
				session.prepareCloseIfIdle();
				return { id: "close", ok: true, result: { closing: true } };
			},
			afterControlResponse: async (_connection, request, response) => {
				afterResponseCalls++;
				if (request.operation === "session.close" && response.ok === true) {
					shutdown = true;
					await session.dispose();
				}
			},
		});
		try {
			await host.start();
			receive("broker", {
				type: "control_request",
				id: "close",
				operation: "session.close",
				input: { ifIdle: true },
			});
			// Join dispatch microtasks without introducing wall-clock races.
			for (let i = 0; i < 100; i++) await Promise.resolve();
			expect(shutdown).toBe(true);
			expect(afterResponseCalls).toBe(1);
			await expect(session.prompt("late prompt")).rejects.toMatchObject({ code: "busy" });
		} finally {
			await host.stop();
			await cleanup();
		}
	});
}

for (const kind of ["refused-close", "non-close"] as const) {
	for (const delivery of ["written", "dropped", "rejected", "before-hook"] as const) {
		test(`${kind} keeps written-only afterControlResponse behavior (${delivery})`, async () => {
			let receive!: (connection: string, frame: Record<string, unknown>) => void;
			let afterResponseCalls = 0;
			const host = new SessionSdkHost({
				sessionId: "close-delivery-matrix",
				stateRoot: "/tmp/idle-close-delivery-matrix",
				token: "fixture-token",
				onFrame(handler) {
					receive = handler;
					return () => {};
				},
				sendFrame(_connection, frame) {
					if (frame.type !== "control_response") return "written";
					if (delivery === "rejected") throw new Error("write rejected");
					return delivery === "written" ? "written" : "dropped";
				},
				beforeControlResponse() {
					if (delivery === "before-hook") throw new Error("before hook failed");
				},
				control() {
					return { id: "request", ok: kind === "non-close" };
				},
				afterControlResponse() {
					afterResponseCalls++;
				},
			});
			try {
				await host.start();
				receive("client", {
					type: "control_request",
					id: "request",
					operation: kind === "refused-close" ? "session.close" : "turn.prompt",
					input: {},
				});
				for (let i = 0; i < 100; i++) await Promise.resolve();
				expect(afterResponseCalls).toBe(delivery === "written" ? 1 : 0);
			} finally {
				await host.stop();
			}
		});
	}
}

for (const fault of ["dropped", "rejected"] as const) {
	test(`SDK-only production runtime shuts down after ${fault} close response`, async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-close-delivery-"));
		try {
			const child = Bun.spawn(
				[
					process.execPath,
					"run",
					path.join(import.meta.dirname, "fixtures/sdk-idle-close-delivery-runtime.ts"),
					fault,
				],
				{
					cwd: root,
					env: {
						...process.env,
						HOME: root,
						GJC_LIFECYCLE_REQUEST_ID: "fixture-close-capability",
						GJC_AGENT_DIR: root,
						GJC_CODING_AGENT_DIR: root,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			expect(JSON.parse(stdout)).toEqual({ accepted: true, shutdown: true });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
}
