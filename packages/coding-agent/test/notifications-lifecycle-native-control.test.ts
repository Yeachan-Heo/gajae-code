import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { NotificationControlServer } from "../../natives/native/index.js";

const UNSUPPORTED_PLATFORM_MESSAGE =
	"Remote session lifecycle is unavailable on this psmux host because GJC cannot prove immutable session identity. No lifecycle action was performed. Use a local GJC terminal with a supported tmux provider.";

describe("native lifecycle control response boundary", () => {
	test("routes unsupported_platform JSON from the JS callback to the originating live WebSocket client", async () => {
		const token = "native-control-test-token";
		const requestId = "unsupported-platform-request";
		const server = new NotificationControlServer(token, "native-control-test-owner");
		let callbackRequestId: string | undefined;
		server.onLifecycleRequest((err, request) => {
			expect(err).toBeNull();
			callbackRequestId = request.requestId;
			server.respond(
				JSON.stringify({
					type: "session_lifecycle_error",
					requestId: request.requestId,
					status: "error",
					reason: "unsupported_platform",
					message: UNSUPPORTED_PLATFORM_MESSAGE,
				}),
			);
		});

		try {
			const endpoint = await server.start();
			const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const socket = new WebSocket(`${endpoint.url}/?token=${token}`);
				const timer = setTimeout(() => reject(new Error("timed out waiting for lifecycle response")), 4_000);
				socket.on("open", () => {
					socket.send(
						JSON.stringify({
							type: "session_close",
							requestId,
							updateId: 1,
							chatId: "test-chat",
							token,
							target: { sessionId: "session-test" },
							force: true,
						}),
					);
				});
				socket.on("message", data => {
					clearTimeout(timer);
					socket.close();
					resolve(JSON.parse(String(data)) as Record<string, unknown>);
				});
				socket.on("error", error => {
					clearTimeout(timer);
					reject(error);
				});
			});

			expect(callbackRequestId).toBe(requestId);
			expect(response).toEqual({
				type: "session_lifecycle_error",
				requestId,
				status: "error",
				reason: "unsupported_platform",
				message: UNSUPPORTED_PLATFORM_MESSAGE,
			});
		} finally {
			server.stop();
		}
	}, 10_000);
	test("rejects invalid lifecycle response JSON without delivering a frame", async () => {
		const token = "native-control-invalid-response-token";
		const server = new NotificationControlServer(token, "native-control-test-owner");
		let rejected = false;
		server.onLifecycleRequest((err, request) => {
			expect(err).toBeNull();
			expect(() =>
				server.respond(
					JSON.stringify({
						type: "session_lifecycle_error",
						requestId: request.requestId,
						status: "error",
						reason: "not_a_lifecycle_reason",
						message: "invalid response",
					}),
				),
			).toThrow();
			rejected = true;
		});

		try {
			const endpoint = await server.start();
			await new Promise<void>((resolve, reject) => {
				const socket = new WebSocket(`${endpoint.url}/?token=${token}`);
				const timer = setTimeout(() => {
					socket.close();
					resolve();
				}, 100);
				socket.on("open", () => {
					socket.send(
						JSON.stringify({
							type: "session_close",
							requestId: "invalid-response-request",
							updateId: 1,
							chatId: "test-chat",
							token,
							target: { sessionId: "session-test" },
							force: true,
						}),
					);
				});
				socket.on("message", data => {
					clearTimeout(timer);
					socket.close();
					reject(new Error(`invalid response delivered a frame: ${String(data)}`));
				});
				socket.on("error", error => {
					clearTimeout(timer);
					reject(error);
				});
			});
			expect(rejected).toBeTrue();
		} finally {
			server.stop();
		}
	}, 10_000);
});
