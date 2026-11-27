import { describe, expect, it } from "bun:test";
import { lifecycleFingerprint, lifecycleRequestIdentity } from "../src/sdk/client/lifecycle-fingerprint";

describe("lifecycle idempotency identity", () => {
	const operation = "session.create";
	const input = { target: { kind: "plain_dir", path: "/tmp/example" }, title: "example" };

	it("matches the pre-consolidation broker/client digest", () => {
		expect(lifecycleFingerprint(operation, input)).toBe(
			"cb65ba18de3f907f8717c52f8d78da1c3bb2f233c5f72f9681809ff1bf6fa0b8",
		);
	});

	it("excludes broker signing material from the identity", () => {
		const withSigning = {
			...input,
			coordinatorSidecarSigningKey: "secret",
			coordinatorSidecarKeyId: "key-id",
		};
		expect(lifecycleFingerprint(operation, withSigning)).toBe(lifecycleFingerprint(operation, input));
		expect(lifecycleRequestIdentity(withSigning)).toEqual(input);
	});

	it("does not mutate caller input", () => {
		const withSigning = {
			...input,
			coordinatorSidecarSigningKey: "secret",
			coordinatorSidecarKeyId: "key-id",
		};
		const snapshot = structuredClone(withSigning);
		lifecycleFingerprint(operation, withSigning);
		expect(withSigning).toEqual(snapshot);
	});

	it("separates operations and inputs", () => {
		expect(lifecycleFingerprint(operation, input)).not.toBe(lifecycleFingerprint("session.fork", input));
		expect(lifecycleFingerprint(operation, input)).not.toBe(
			lifecycleFingerprint(operation, { ...input, title: "other" }),
		);
	});

	it("hashes non-object inputs without treating them as records", () => {
		expect(lifecycleFingerprint(operation, "value")).not.toBe(lifecycleFingerprint(operation, "other"));
	});
});
