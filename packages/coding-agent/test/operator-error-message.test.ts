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

	it("renders a pure re-raise of the persistence error as the operator text alone", () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const reraised = new Error(mismatch.message, { cause: mismatch });
		const byCode = new Error("managed_append_identity_mismatch", { cause: new Error("middle", { cause: mismatch }) });
		expect(findOperatorMessage(reraised)).toBe(mismatch.operatorMessage);
		expect(operatorErrorMessage(byCode)).toBe(mismatch.operatorMessage);
	});

	it("keeps a wrapper's own failure in front of the operator text", () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		// session-manager: an invariant failure while rolling back a refused append.
		const invariant = new Error("Session append rollback lost resident ordering.", { cause: mismatch });
		// session-manager: a failed managed-move rollback after a refused write.
		const rollback = new Error("Failed to rollback managed move: EIO", { cause: mismatch });
		expect(operatorErrorMessage(invariant)).toBe(
			`Session append rollback lost resident ordering. ${mismatch.operatorMessage}`,
		);
		expect(operatorErrorMessage(rollback)).toBe(`Failed to rollback managed move: EIO. ${mismatch.operatorMessage}`);
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

	it("never leaks a wrapper's own message or paths on the SDK and ACP boundaries", async () => {
		const row = OPERATIONS.find(candidate => candidate.sdkId === "turn.prompt");
		if (!row) throw new Error("Missing turn.prompt operation");
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const wrapper = new Error("Failed to rollback managed move: EACCES /home/someone/private/file", {
			cause: mismatch,
		});
		const surface = {
			prompt: () => {
				throw wrapper;
			},
		} as unknown as ControlSurface;

		const response = await dispatchControl(surface, row, {
			id: "wrapped",
			operation: "turn.prompt",
			input: { text: "x" },
		});
		const acp = acpRequestFailure(Object.assign(wrapper, { code: "internal_rollback" })) as Error & {
			data?: Record<string, unknown>;
		};

		expect(response.error).toEqual({ code: "internal", message: "Control operation failed." });
		expect(findOperatorMessage(wrapper)).toBeUndefined();
		expect(acp.data?.operatorMessage).toBeUndefined();
		// Local surfaces still show both the real failure and the recovery.
		expect(operatorErrorMessage(wrapper)).toBe(
			`Failed to rollback managed move: EACCES /home/someone/private/file. ${mismatch.operatorMessage}`,
		);
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
