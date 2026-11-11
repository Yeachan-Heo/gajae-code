import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { OPERATIONS } from "./protocol/operation-registry";

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
export const SECURE_LOCAL_OPERATIONS = [
	"auth.login", "auth.providers.status", "auth.status", "auth.start", "auth.read", "auth.answer", "auth.cancel", "auth.apiKey.store",
] as const;
export type SecureLocalOperation = (typeof SECURE_LOCAL_OPERATIONS)[number];
export const SECURE_LOCAL_PROOF_FIELD = "__sdkLocalGrant";
const GRANT_TTL_MS = 30_000;
export function isSecureLocalOperation(value: unknown): value is SecureLocalOperation {
	return typeof value === "string" && SECURE_LOCAL_OPERATIONS.some(operation => operation === value);
}
export function secureLocalFrameOperation(frame: Record<string, unknown>): SecureLocalOperation | undefined {
	const operation = frame.type === "control_request" ? frame.operation : frame.type === "query_request" ? frame.query : undefined;
	if (isSecureLocalOperation(operation)) return operation;
	if (frame.type === "query_request") {
		const canonical = OPERATIONS.find(row => row.kind === "query" && row.id === operation)?.sdkId;
		if (isSecureLocalOperation(canonical)) return canonical;
	}
	return undefined;
}
function digest(token: string, frame: Record<string, unknown>, nonce: string, expiresAt: number): string {
	// SdkClient assigns the correlation id after Router's authority fence. The
	// single-use nonce binds the grant instead; no caller id grants authority.
	return createHmac("sha256", token).update("gjc-secure-local-operation-v1\0")
		.update(JSON.stringify([nonce, expiresAt, frame.type, frame.operation ?? frame.query, frame.input ?? {}])).digest("hex");
}
/** Internal single-use attachment attestation. Endpoint credentials stay in SDK core. */
export function signSecureLocalFrame(token: string, frame: Record<string, unknown>): string {
	const expiresAt = Date.now() + GRANT_TTL_MS;
	const nonce = randomUUID();
	return `${expiresAt}.${nonce}.${digest(token, frame, nonce, expiresAt)}`;
}
export function verifySecureLocalFrame(token: string, frame: Record<string, unknown>): boolean {
	const proof = frame[SECURE_LOCAL_PROOF_FIELD];
	if (typeof proof !== "string") return false;
	const parts = /^(\d{13})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(proof);
	if (!parts) return false;
	const expiresAt = Number(parts[1]);
	if (expiresAt < Date.now() || expiresAt > Date.now() + GRANT_TTL_MS) return false;
	return timingSafeEqual(Buffer.from(parts[3]!, "hex"), Buffer.from(digest(token, frame, parts[2]!, expiresAt), "hex"));
}

/** Bounded host-local replay fence; contains only short-lived attestations, never request bodies or credentials. */
export class SecureLocalGrantReplayFence {
	readonly #used = new Map<string, number>();
	consume(frame: Record<string, unknown>): boolean {
		const now = Date.now();
		for (const [proof, expiry] of this.#used) if (expiry < now) this.#used.delete(proof);
		const proof = frame[SECURE_LOCAL_PROOF_FIELD];
		if (typeof proof !== "string" || this.#used.has(proof) || this.#used.size >= 256) return false;
		this.#used.set(proof, Number(proof.split(".", 1)[0]));
		return true;
	}
}
