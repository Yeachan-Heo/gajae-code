import { expect, test } from "bun:test";
import { SessionSdkHost } from "../src/sdk/host/host";
import { dispatchControl, type ControlSurface } from "../src/sdk/host/control";
import { findOperation } from "../src/sdk/protocol/operation-registry";
import { SECURE_LOCAL_PROOF_FIELD, secureLocalFrameOperation, signSecureLocalFrame, verifySecureLocalFrame } from "../src/sdk/secure-local-controls";

test("exact grants bind body, operation and endpoint token, including numeric queries", () => {
	const frame = { type: "control_request", id: "request", operation: "auth.apiKey.store", input: { provider: "test", key: "secret" } };
	const signed = { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame("endpoint-token", frame) };
	expect(verifySecureLocalFrame("endpoint-token", signed)).toBe(true);
	expect(verifySecureLocalFrame("other-endpoint", signed)).toBe(false);
	expect(verifySecureLocalFrame("endpoint-token", { ...signed, operation: "auth.start" })).toBe(false);
	expect(verifySecureLocalFrame("endpoint-token", { ...signed, input: { provider: "other", key: "secret" } })).toBe(false);
	expect(secureLocalFrameOperation({ type: "query_request", query: "Q38" })).toBe("auth.read");
});

test("host rejects forged and replayed grants before observers and never logs authorization bodies", async () => {
	let receive!: (connection: string, frame: Record<string, unknown>) => void;
	const sent: Record<string, unknown>[] = [];
	const observed: unknown[] = [];
	const admitted: unknown[] = [];
	let effects = 0;
	const host = new SessionSdkHost({
		sessionId: "secure-local-test", stateRoot: "/tmp/secure-local-test", token: "internal-endpoint-token",
		onFrame: handler => { receive = handler; return () => {}; },
		sendFrame: (_connection, frame) => { sent.push(frame); return "written"; },
		onRequest: (...args) => observed.push(args), onFrameAdmitted: (...args) => observed.push(args),
		onFrameAdmission: (_connection, frame) => { admitted.push(frame); return undefined; },
		beforeControlResponse: (...args) => { observed.push(args); },
		afterControlResponse: (...args) => { observed.push(args); },
		onControlResponseDelivery: (...args) => { observed.push(args); },
		control: () => { effects++; return { id: "store", ok: true, result: { saved: true } }; },
	});
	await host.start();
	try {
		const frame = { type: "control_request", id: "store", operation: "auth.apiKey.store", input: { provider: "test", key: "never-in-observers" }, capabilities: ["auth.apiKey.store"] };
		receive("untrusted", frame); await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(0);
		const signed = { ...frame, [SECURE_LOCAL_PROOF_FIELD]: signSecureLocalFrame("internal-endpoint-token", frame) };
		receive("trusted", signed); await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: true, result: { saved: true } });
		expect(effects).toBe(1);
		receive("replay", signed); await Bun.sleep(0);
		expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
		expect(effects).toBe(1);
		expect(observed).toEqual([]);
		expect(JSON.stringify(admitted)).not.toContain("never-in-observers");
		expect(JSON.stringify(admitted)).not.toContain(SECURE_LOCAL_PROOF_FIELD);
		expect(JSON.stringify(host.events.replay(0))).not.toContain("never-in-observers");
	} finally { await host.stop(); }
});

test("secret-bearing controls reject idempotency retention before invoking effects", async () => {
	let effects = 0;
	const surface = { authorizationControl: () => { effects++; return { saved: true }; } } as unknown as ControlSurface;
	const row = findOperation("control", "auth.apiKey.store");
	for (let index = 0; index < 2; index++) {
		const response = await dispatchControl(surface, row, { id: String(index), operation: "auth.apiKey.store", input: { provider: "test", key: "secret" }, idempotencyKey: "do-not-retain" });
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	}
	expect(effects).toBe(0);
});
