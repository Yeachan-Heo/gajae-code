import { describe, expect, it } from "bun:test";
import { TempDir } from "@gajae-code/utils";
import { acpRequestFailure } from "../src/modes/acp/acp-agent";
import { SessionSdkHost } from "../src/sdk/host";
import { type ControlSurface, dispatchControl } from "../src/sdk/host/control";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { findOperatorMessage, operatorErrorMessage } from "../src/session/operator-error-message";

describe("operatorErrorMessage", () => {
	it("renders the operator text instead of the machine code", () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		expect(mismatch.message).toBe("managed_append_identity_mismatch");
		expect(operatorErrorMessage(mismatch)).toBe(mismatch.operatorMessage);
	});

	it("finds the operator text through a wrapper's cause chain", () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: mismatch }) });
		expect(findOperatorMessage(wrapped)).toBe(mismatch.operatorMessage);
		expect(operatorErrorMessage(wrapped)).toBe(mismatch.operatorMessage);
	});

	it("keeps ordinary messages and each site's non-Error fallback", () => {
		expect(operatorErrorMessage(new Error("plain failure"))).toBe("plain failure");
		expect(findOperatorMessage(new Error("plain failure"))).toBeUndefined();
		expect(operatorErrorMessage(Object.assign(new Error("blank"), { operatorMessage: "  " }))).toBe("blank");
		expect(operatorErrorMessage("thrown string")).toBe("Unknown error occurred");
		expect(operatorErrorMessage(42, String(42))).toBe("42");
	});
});

describe("operator text on SDK and ACP surfaces", () => {
	it("returns the operator text for a refused SDK prompt and keeps the internal code", async () => {
		const row = OPERATIONS.find(candidate => candidate.sdkId === "turn.prompt");
		if (!row) throw new Error("Missing turn.prompt operation");
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const surface = {
			prompt: () => {
				throw mismatch;
			},
		} as unknown as ControlSurface;
		const response = await dispatchControl(surface, row, {
			id: "refused",
			operation: "turn.prompt",
			input: { text: "hello" },
		});
		expect(response).toMatchObject({
			id: "refused",
			ok: false,
			error: { code: "internal", message: mismatch.operatorMessage },
		});
	});

	it("keeps the opaque SDK fallback for errors without operator text", async () => {
		const row = OPERATIONS.find(candidate => candidate.sdkId === "turn.prompt");
		if (!row) throw new Error("Missing turn.prompt operation");
		const surface = {
			prompt: () => {
				throw new Error("private detail /home/someone/file");
			},
		} as unknown as ControlSurface;
		const response = await dispatchControl(surface, row, {
			id: "opaque",
			operation: "turn.prompt",
			input: { text: "x" },
		});
		expect(response.error).toEqual({ code: "internal", message: "Control operation failed." });
	});

	it("publishes an ACP refusal's operator text in data.operatorMessage and keeps details", () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const failure = acpRequestFailure(mismatch) as Error & {
			data?: { code?: unknown; details?: unknown; operatorMessage?: unknown };
		};
		expect(failure.data?.code).toBe("managed_append_identity_mismatch");
		expect(failure.data?.details).toBe("managed_append_identity_mismatch");
		expect(failure.data?.operatorMessage).toBe(mismatch.operatorMessage);
	});

	it("adds no operatorMessage key to ACP errors without operator text", () => {
		const failure = acpRequestFailure(Object.assign(new Error("busy now"), { code: "busy" })) as Error & {
			data?: Record<string, unknown>;
		};
		expect(failure.data).toEqual({ code: "busy", details: "busy now" });
	});

	it("sends the operator text in an SDK host error frame and keeps the error code", async () => {
		const tempDir = TempDir.createSync("@gjc-sdk-host-error-frame-");
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<Record<string, unknown>> = [];
		const host = new SessionSdkHost({
			sessionId: "error-frame",
			stateRoot: tempDir.path(),
			token: "token",
			sendFrame: (_connectionId, frame) => {
				sent.push(frame);
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
			control: () => {
				throw mismatch;
			},
		});
		try {
			await host.start();
			receive("client", { type: "control_request", id: "c1", operation: "turn.prompt", input: { text: "hi" } });
			for (let attempt = 0; attempt < 50 && sent.length === 0; attempt++) await Bun.sleep(1);
			expect(sent).toEqual([
				{
					type: "control_response",
					id: "c1",
					ok: false,
					error: { code: "managed_append_identity_mismatch", message: mismatch.operatorMessage },
				},
			]);
		} finally {
			await host.stop();
			tempDir.removeSync();
		}
	});
});
