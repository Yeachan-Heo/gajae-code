import * as crypto from "node:crypto";

export interface BridgeAuthConfig {
	token: string;
}

export interface BridgeBindConfig {
	hostname: string;
	port: number;
	tlsConfigured: boolean;
}

export function extractBearerToken(authorization: string | null | undefined): string | undefined {
	if (!authorization) return undefined;
	const trimmed = authorization.trim();
	const match = /^Bearer\s+(.+)$/i.exec(trimmed);
	const token = match?.[1]?.trim();
	return token ? token : undefined;
}

export function isBridgeTokenAuthorized(authorization: string | null | undefined, config: BridgeAuthConfig): boolean {
	const candidate = extractBearerToken(authorization);
	if (candidate === undefined) return false;
	const candidateBytes = Buffer.from(candidate, "utf8");
	const expectedBytes = Buffer.from(config.token, "utf8");
	return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

export function isLoopbackHost(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function assertSafeBridgeBind(config: BridgeBindConfig): void {
	if (!config.tlsConfigured) {
		throw new Error(
			`Refusing to start bridge on ${config.hostname}:${config.port} without TLS configured. ` +
				"Set GJC_BRIDGE_TLS_CERT and GJC_BRIDGE_TLS_KEY.",
		);
	}
}
