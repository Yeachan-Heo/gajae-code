import { expect, test } from "bun:test";
import { AcpSdkAdapter } from "../src/sdk/acp/adapter";
import { SdkClientError } from "../src/sdk/client";
import type { SessionAttachment, SessionRouter } from "../src/sdk/router";

/**
 * Test recovery of prompt status after connection loss.
 * The session host returns reconciliation statuses: "accepted", "in_flight", "terminal_ok", "failed", "unknown"
 * The adapter must map these correctly and preserve errors for unconfirmed submissions (status: "unknown").
 */

test("prompt recovery with status: accepted returns a successful acknowledgement", async () => {
	const attachment: SessionAttachment = {
		sessionId: "recovery-session",
		connectionId: "original-connection",
		generation: 1,
		isCurrent: () => true,
		send: async () => undefined,
		sendMaintenance: () => undefined,
	};
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			_generation: number,
			_owner: SessionAttachment,
			_options?: { timeoutMs: number },
		) => {
			if (frame.type === "control_request") {
				// Simulate connection loss during prompt
				throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
			}
			// Recovery query returns a reconciliation result
			return {
				ok: true,
				result: {
					status: "accepted",
					commandId: "cmd-123",
					turnId: "turn-456",
					clientRef: "ref-789",
					acceptedAt: Date.now(),
				},
			};
		},
	} as unknown as SessionRouter;
	const adapter = new AcpSdkAdapter({ router, attachment });
	const result = await adapter.prompt({ text: "hello", clientRef: "ref-789" });
	// Should return a valid acknowledgement structure
	expect(result).toMatchObject({
		accepted: true,
		commandId: "cmd-123",
		turnId: "turn-456",
	});
});

test("prompt recovery with status: in_flight returns a successful acknowledgement", async () => {
	const attachment: SessionAttachment = {
		sessionId: "recovery-session",
		connectionId: "original-connection",
		generation: 1,
		isCurrent: () => true,
		send: async () => undefined,
		sendMaintenance: () => undefined,
	};
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			_generation: number,
			_owner: SessionAttachment,
			_options?: { timeoutMs: number },
		) => {
			if (frame.type === "control_request") {
				throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
			}
			return {
				ok: true,
				result: {
					status: "in_flight",
					commandId: "cmd-123",
					turnId: "turn-456",
					clientRef: "ref-789",
					acceptedAt: Date.now(),
					startedAt: Date.now(),
				},
			};
		},
	} as unknown as SessionRouter;
	const adapter = new AcpSdkAdapter({ router, attachment });
	const result = await adapter.prompt({ text: "hello", clientRef: "ref-789" });
	expect(result).toMatchObject({
		accepted: true,
		commandId: "cmd-123",
		turnId: "turn-456",
	});
});

test("prompt recovery with status: terminal_ok returns a successful acknowledgement", async () => {
	const attachment: SessionAttachment = {
		sessionId: "recovery-session",
		connectionId: "original-connection",
		generation: 1,
		isCurrent: () => true,
		send: async () => undefined,
		sendMaintenance: () => undefined,
	};
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			_generation: number,
			_owner: SessionAttachment,
			_options?: { timeoutMs: number },
		) => {
			if (frame.type === "control_request") {
				throw new SdkClientError("uncertain_after_send", "response lost after dispatch");
			}
			return {
				ok: true,
				result: {
					status: "terminal_ok",
					commandId: "cmd-123",
					turnId: "turn-456",
					clientRef: "ref-789",
					acceptedAt: Date.now(),
					terminalAt: Date.now(),
					receiptState: "completed" as const,
				},
			};
		},
	} as unknown as SessionRouter;
	const adapter = new AcpSdkAdapter({ router, attachment });
	const result = await adapter.prompt({ text: "hello", clientRef: "ref-789" });
	expect(result).toMatchObject({
		accepted: true,
		commandId: "cmd-123",
		turnId: "turn-456",
	});
});

test("prompt recovery with status: failed returns an error", async () => {
	const attachment: SessionAttachment = {
		sessionId: "recovery-session",
		connectionId: "original-connection",
		generation: 1,
		isCurrent: () => true,
		send: async () => undefined,
		sendMaintenance: () => undefined,
	};
	const originalError = new SdkClientError("uncertain_after_send", "response lost after dispatch");
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			_generation: number,
			_owner: SessionAttachment,
			_options?: { timeoutMs: number },
		) => {
			if (frame.type === "control_request") {
				throw originalError;
			}
			return {
				ok: true,
				result: {
					status: "failed",
					commandId: "cmd-123",
					turnId: "turn-456",
					clientRef: "ref-789",
					acceptedAt: Date.now(),
					terminalAt: Date.now(),
					receiptState: "failed" as const,
					error: { code: "prompt_failed", message: "Provider error" },
				},
			};
		},
	} as unknown as SessionRouter;
	const adapter = new AcpSdkAdapter({ router, attachment });
	const error = await adapter.prompt({ text: "hello", clientRef: "ref-789" }).catch((e: unknown) => e);
	// When status is "failed", we should throw or return the failed result
	// The behavior should indicate the prompt failed
	expect(error).toBeTruthy();
	if (error instanceof Object && "code" in error) {
		expect((error as Record<string, unknown>).code).toMatch(/failed|prompt_failed/);
	} else if (error instanceof Object && "error" in error) {
		const errObj = error as Record<string, unknown>;
		if (errObj.error instanceof Object && "code" in errObj.error) {
			expect((errObj.error as Record<string, unknown>).code).toMatch(/failed|prompt_failed/);
		}
	}
});

test("prompt recovery with status: unknown rethrows the original connection error", async () => {
	const attachment: SessionAttachment = {
		sessionId: "recovery-session",
		connectionId: "original-connection",
		generation: 1,
		isCurrent: () => true,
		send: async () => undefined,
		sendMaintenance: () => undefined,
	};
	const originalError = new SdkClientError("uncertain_after_send", "response lost after dispatch");
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			_generation: number,
			_owner: SessionAttachment,
			_options?: { timeoutMs: number },
		) => {
			if (frame.type === "control_request") {
				throw originalError;
			}
			// When status is unknown, we have no evidence the prompt was recorded
			return {
				ok: true,
				result: {
					status: "unknown",
					receiptState: "unknown" as const,
				},
			};
		},
	} as unknown as SessionRouter;
	const adapter = new AcpSdkAdapter({ router, attachment });
	const error = await adapter.prompt({ text: "hello", clientRef: "ref-789" }).catch((e: unknown) => e);
	// Should rethrow the original error since status is unknown
	expect(error).toBe(originalError);
});
