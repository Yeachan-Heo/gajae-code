import { expect, test } from "bun:test";
import { createAppServerRuntime } from "../create-app-server";

const enc = (value: string) => new TextEncoder().encode(value);

test("requestApproval cancels when the signal aborts during listener installation", async () => {
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(() => {});
	try {
		await connection.process(
			enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"abort-test","version":"1.0.0"}}}'),
		);
		await connection.process(enc('{"method":"initialized"}'));
		runtime.subscriptions.subscribe(connection.id, "thread-abort-race");
		let aborted = false;
		const signal = {
			get aborted() {
				return aborted;
			},
			addEventListener() {
				aborted = true;
			},
			removeEventListener() {},
		} as unknown as AbortSignal;
		await expect(
			runtime.requestApproval(
				"thread-abort-race",
				"execCommandApproval",
				{
					conversationId: "thread-abort-race",
					callId: "call-1",
					approvalId: null,
					command: ["ls"],
					cwd: "/tmp",
					reason: null,
					parsedCmd: [],
				},
				signal,
			),
		).rejects.toThrow("approval request aborted");
		expect(runtime.broker.pendingCount).toBe(0);
	} finally {
		await runtime.close();
	}
});
