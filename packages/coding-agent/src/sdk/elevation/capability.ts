import { createHmac, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { canonicalElevationJson } from "./digest";

const CAPABILITY_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

function payload(requestId: string, sdkId: string, input: Record<string, unknown>): string {
	return canonicalElevationJson({ requestId, kind: "control", sdkId, input });
}

export function signElevationCapability(
	authorityToken: string,
	requestId: string,
	sdkId: string,
	input: Record<string, unknown>,
): string {
	const signature = createHmac("sha256", authorityToken)
		.update(payload(requestId, sdkId, input))
		.digest("hex");
	return `${requestId}.${signature}`;
}

export function verifyElevationCapability(
	authorityToken: string,
	capability: string,
	sdkId: string,
	input: Record<string, unknown>,
): boolean {
	const match = CAPABILITY_PATTERN.exec(capability);
	if (!match) return false;
	const requestId = match[1]!;
	const supplied = Buffer.from(match[2]!, "hex");
	const expected = createHmac("sha256", authorityToken)
		.update(payload(requestId, sdkId, input))
		.digest();
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function elevationAuthorityPath(stateRoot: string, sessionId: string): string {
	return path.join(stateRoot, "sdk", ".authority", `${sessionId}.json`);
}
