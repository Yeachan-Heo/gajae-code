import { createHash } from "node:crypto";

/** Bootstrap signing material and its public candidate id authorize a launch but are not lifecycle request identity. */
export function lifecycleRequestIdentity(input: Record<string, unknown>): Record<string, unknown> {
	const identity = { ...input };
	delete identity.coordinatorSidecarSigningKey;
	delete identity.coordinatorSidecarKeyId;
	return identity;
}

/**
 * Canonical idempotency fingerprint for lifecycle requests. Signing material
 * never participates: broker and client must derive the same identity.
 */
export function lifecycleFingerprint(operation: string, input: unknown): string {
	const identity =
		input !== null && typeof input === "object" && !Array.isArray(input)
			? lifecycleRequestIdentity(input as Record<string, unknown>)
			: input;
	return createHash("sha256")
		.update(JSON.stringify({ operation, input: identity }))
		.digest("hex");
}
