import { describe, expect, it } from "bun:test";
import {
	canonicalArgsKey,
	classifyToolOutcome,
	decideTimeoutHold,
	toResultText,
	turnTimeoutFingerprint,
} from "@gajae-code/coding-agent/goals/continuation-timeout-guard";

describe("continuation timeout guard", () => {
	it("classifies timeout, successful, and other-error tool outcomes", () => {
		expect(classifyToolOutcome(true, "Command timed out after 10 ms")).toBe("timeout");
		expect(classifyToolOutcome(false, "Command timed out after 10 ms")).toBe("success");
		expect(classifyToolOutcome(true, "permission denied")).toBe("other-error");
	});

	it("only reads text content when classifying a result", () => {
		const result = {
			content: [{ type: "text", text: "permission denied" }],
			details: { timeoutMs: 10 },
		};
		expect(toResultText(result)).toBe("permission denied");
		expect(classifyToolOutcome(true, toResultText(result))).toBe("other-error");
	});

	it("canonicalizes nested object keys while preserving array order", () => {
		expect(canonicalArgsKey({ b: [{ z: 1, a: 2 }], a: { d: 4, c: 3 }, unset: undefined })).toBe(
			canonicalArgsKey({ a: { c: 3, d: 4 }, b: [{ a: 2, z: 1 }] }),
		);
	});

	it("only fingerprints non-empty identical timeout outcomes", () => {
		const timeout = { toolName: "bash", argsKey: '{"command":"slow"}', kind: "timeout" as const };
		expect(turnTimeoutFingerprint([])).toBeNull();
		expect(turnTimeoutFingerprint([{ ...timeout, kind: "success" }])).toBeNull();
		expect(turnTimeoutFingerprint([timeout, { ...timeout, kind: "other-error" }])).toBeNull();
		expect(turnTimeoutFingerprint([timeout, { ...timeout, argsKey: '{"command":"other"}' }])).toBeNull();
		expect(turnTimeoutFingerprint([timeout])).toBe('bash\u0000{"command":"slow"}');
		expect(turnTimeoutFingerprint([timeout, timeout])).toBe('bash\u0000{"command":"slow"}');
	});

	it("holds on the second same-snapshot fingerprint and resets on changes", () => {
		const first = decideTimeoutHold({ streak: 0 }, { snapshotKey: "goal-a", fingerprint: "bash\u0000{}" });
		expect(first).toEqual({
			hold: false,
			next: { heldSnapshotKey: "goal-a", fingerprint: "bash\u0000{}", streak: 1 },
		});
		const second = decideTimeoutHold(first.next, { snapshotKey: "goal-a", fingerprint: "bash\u0000{}" });
		expect(second.hold).toBe(true);
		expect(second.next.streak).toBe(2);
		expect(decideTimeoutHold(second.next, { snapshotKey: "goal-b", fingerprint: "bash\u0000{}" })).toEqual({
			hold: false,
			next: { heldSnapshotKey: "goal-b", fingerprint: "bash\u0000{}", streak: 1 },
		});
		expect(decideTimeoutHold(second.next, { snapshotKey: "goal-a", fingerprint: "read\u0000{}" })).toEqual({
			hold: false,
			next: { heldSnapshotKey: "goal-a", fingerprint: "read\u0000{}", streak: 1 },
		});
	});
});
