import { expect, test } from "bun:test";
import { ACP_SESSION_RECONNECT, AcpSdkAdapter } from "../src/sdk/acp";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";
import { SdkClientError } from "../src/sdk/client";
import type { SessionAttachment, SessionRouter } from "../src/sdk/router";
import { expectedBackoffs } from "./helpers/fake-sdk-transport";

test("ACP session reconnect budget outlives the host heartbeat TTL", () => {
	const backoffs = expectedBackoffs(ACP_SESSION_RECONNECT);
	const totalBudgetMs = backoffs.reduce((total, backoff) => total + backoff, 0);
	// The host drops a session whose client has not ponged within HEARTBEAT_TTL_MS,
	// so a shorter client budget makes every host-reaped stall unrecoverable.
	expect(totalBudgetMs).toBeGreaterThan(HEARTBEAT_TTL_MS);
	// Recovery must stay prompt: no single sleep may swallow the whole TTL.
	expect(Math.max(...backoffs)).toBe(ACP_SESSION_RECONNECT.reconnectMaxBackoffMs);
	expect(ACP_SESSION_RECONNECT.reconnectMaxBackoffMs).toBeLessThan(HEARTBEAT_TTL_MS);
});

test("AcpSdkAdapter requires an explicit Broker client or SessionRouter", async () => {
	expect(() => new AcpSdkAdapter({})).toThrow("exactly one Broker client or SessionRouter");
	await expect(AcpSdkAdapter.connect({})).rejects.toMatchObject({ code: "invalid_input" });
});

for (const kind of ["prompt", "skill"] as const) {
	test(`ACP ${kind} uncertainty retains clientRef for a session-bound read without replay`, async () => {
		const requests: Record<string, unknown>[] = [];
		const attachment: SessionAttachment = {
			sessionId: "recovery-session",
			connectionId: "original-connection",
			generation: 7,
			isCurrent: () => true,
			send: async () => undefined,
			sendMaintenance: () => undefined,
		};
		const router = {
			request: async (
				sessionId: string,
				frame: Record<string, unknown>,
				generation: number,
				owner: SessionAttachment,
				options?: { timeoutMs: number },
			) => {
				expect(sessionId).toBe(attachment.sessionId);
				expect(generation).toBe(7);
				expect(owner).toBe(attachment);
				expect(options).toBeUndefined();
				requests.push(frame);
				if (frame.type === "control_request") throw new SdkClientError("uncertain_after_send", "response lost");
				return { ok: true, result: { kind, clientRef: "owned-ref", status: "unknown" } };
			},
		} as unknown as SessionRouter;
		const adapter = new AcpSdkAdapter({ router, attachment });
		const mutation =
			kind === "prompt"
				? adapter.prompt({ text: "hello", clientRef: "owned-ref" })
				: adapter.control("skill.invoke", { name: "review", args: "hello", clientRef: "owned-ref" });
		await expect(mutation).rejects.toMatchObject({ code: "uncertain_after_send" });
		expect(await adapter.query("turn.result", { kind, clientRef: "owned-ref" })).toEqual({
			kind,
			clientRef: "owned-ref",
			status: "unknown",
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({
			type: "control_request",
			operation: kind === "prompt" ? "turn.prompt" : "skill.invoke",
			input: { clientRef: "owned-ref" },
		});
		expect(requests[1]).toMatchObject({
			type: "query_request",
			query: "turn.result",
			input: { kind, clientRef: "owned-ref" },
		});
	});
}
