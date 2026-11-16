import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isSecureLocalOperation, type SecureLocalOperation } from "./protocol/client-control-contracts";
import { OPERATIONS } from "./protocol/operation-registry";

export const SECURE_LOCAL_PROOF_FIELD = "__sdkLocalGrant";
const GRANT_TTL_MS = 30_000;
export function secureLocalFrameOperation(frame: Record<string, unknown>): SecureLocalOperation | undefined {
	if (frame.type === "query_request" && Object.hasOwn(frame, "operation")) return undefined;
	const operation =
		frame.type === "control_request" ? frame.operation : frame.type === "query_request" ? frame.query : undefined;
	if (isSecureLocalOperation(operation)) return operation;
	if (frame.type === "query_request") {
		const canonical = OPERATIONS.find(row => row.kind === "query" && row.id === operation)?.sdkId;
		if (isSecureLocalOperation(canonical)) return canonical;
	}
	return undefined;
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map(key => [key, canonical(record[key])]),
		);
	}
	return value;
}
function digest(
	authority: string,
	endpointToken: string,
	frame: Record<string, unknown>,
	nonce: string,
	expiresAt: number,
): string {
	const body = { ...frame };
	delete body[SECURE_LOCAL_PROOF_FIELD];
	// Bind every wire field, including correlation identity, pagination and
	// idempotency. Only the proof itself is omitted; endpoint identity is also
	// bound independently of any caller-supplied token field.
	return createHmac("sha256", authority)
		.update("gjc-secure-local-operation-v2\0")
		.update(JSON.stringify([endpointToken, nonce, expiresAt, canonical(body)]))
		.digest("hex");
}
/** Internal single-use attachment attestation. Independent authority never crosses the wire. */
export function signSecureLocalFrame(authority: string, endpointToken: string, frame: Record<string, unknown>): string {
	if (!authority || !secureLocalFrameOperation(frame)) throw new TypeError("Invalid secure-local SDK grant.");
	const expiresAt = Date.now() + GRANT_TTL_MS;
	const nonce = randomUUID();
	return `${expiresAt}.${nonce}.${digest(authority, endpointToken, frame, nonce, expiresAt)}`;
}
export function verifySecureLocalFrame(
	authority: string,
	endpointToken: string,
	frame: Record<string, unknown>,
): boolean {
	if (!authority || !secureLocalFrameOperation(frame)) return false;
	const proof = frame[SECURE_LOCAL_PROOF_FIELD];
	if (typeof proof !== "string") return false;
	const parts = /^(\d{13})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(proof);
	if (!parts) return false;
	const expiresAt = Number(parts[1]);
	if (expiresAt < Date.now() || expiresAt > Date.now() + GRANT_TTL_MS) return false;
	return timingSafeEqual(
		Buffer.from(parts[3]!, "hex"),
		Buffer.from(digest(authority, endpointToken, frame, parts[2]!, expiresAt), "hex"),
	);
}

/** Bounded host-local replay fence; contains only short-lived attestations, never request bodies or credentials. */
export class SecureLocalGrantReplayFence {
	readonly #used = new Map<string, number>();
	consume(frame: Record<string, unknown>): "accepted" | "rejected" | "capacity" {
		const now = Date.now();
		for (const [proof, expiry] of this.#used) if (expiry < now) this.#used.delete(proof);
		const proof = frame[SECURE_LOCAL_PROOF_FIELD];
		if (typeof proof !== "string" || this.#used.has(proof)) return "rejected";
		if (this.#used.size >= 256) return "capacity";
		this.#used.set(proof, Number(proof.split(".", 1)[0]));
		return "accepted";
	}
}
