import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@gajae-code/utils";
import { getAgentDir } from "@gajae-code/utils/dirs";
import { $credentialEnv } from "@gajae-code/utils/env";

const SMITHERY_AUTH_FILENAME = "smithery.json";
/**
 * Smithery web origin, from trusted environment sources only.
 *
 * This origin serves the CLI auth session and the verification URL the user is
 * sent to, so whatever can set it can drive the login flow. `$env` merges the
 * caller's `cwd/.env` into `process.env`, so reading it there would let
 * repository content redirect that flow.
 */
const SMITHERY_URL = $credentialEnv("SMITHERY_URL") || "https://smithery.ai";

type SmitheryCliAuthSession = {
	sessionId: string;
	authUrl: string;
};

type SmitheryCliPollResponse = {
	status: "pending" | "success" | "error";
	apiKey?: string;
	message?: string;
};

type SmitheryAuthPayload = {
	apiKey?: string;
};

function getSmitheryAuthPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), SMITHERY_AUTH_FILENAME);
}

function normalizeApiKey(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Test seam: the Smithery origin and env API key as resolved from trusted env. */
export function resolveSmitheryEnvForTest(): { url: string; apiKey: string | undefined } {
	return { url: SMITHERY_URL, apiKey: normalizeApiKey($credentialEnv("SMITHERY_API_KEY")) };
}

export function getSmitheryLoginUrl(): string {
	return SMITHERY_URL;
}

export async function createSmitheryCliAuthSession(): Promise<SmitheryCliAuthSession> {
	const response = await fetch(`${SMITHERY_URL}/api/auth/cli/session`, {
		method: "POST",
	});
	if (!response.ok) {
		throw new Error(`Failed to create Smithery auth session: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as SmitheryCliAuthSession;
}

export async function pollSmitheryCliAuthSession(
	sessionId: string,
	signal?: AbortSignal,
): Promise<SmitheryCliPollResponse> {
	const response = await fetch(`${SMITHERY_URL}/api/auth/cli/poll/${sessionId}`, {
		signal,
	});
	if (!response.ok) {
		if (response.status === 404 || response.status === 410) {
			throw new Error("Smithery login session expired. Please try again.");
		}
		throw new Error(`Smithery auth polling failed: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as SmitheryCliPollResponse;
}

export async function getSmitheryApiKey(agentDir?: string): Promise<string | undefined> {
	// Trusted sources only: this key authenticates every Smithery API call.
	const envKey = normalizeApiKey($credentialEnv("SMITHERY_API_KEY"));
	if (envKey) return envKey;

	const authPath = getSmitheryAuthPath(agentDir);
	try {
		const payload = (await Bun.file(authPath).json()) as SmitheryAuthPayload;
		return normalizeApiKey(payload.apiKey);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("Failed to read Smithery auth file, treating as missing", { path: authPath, error });
		return undefined;
	}
}

export async function saveSmitheryApiKey(apiKey: string, agentDir?: string): Promise<void> {
	const normalized = normalizeApiKey(apiKey);
	if (!normalized) {
		throw new Error("Smithery API key cannot be empty.");
	}

	const authPath = getSmitheryAuthPath(agentDir);
	const payload: SmitheryAuthPayload = { apiKey: normalized };
	await Bun.write(authPath, `${JSON.stringify(payload, null, 2)}\n`);
	try {
		await fs.chmod(authPath, 0o600);
	} catch (error) {
		logger.warn("Could not set restrictive permissions on Smithery auth file", { path: authPath, error });
	}
}

export async function clearSmitheryApiKey(agentDir?: string): Promise<boolean> {
	const authPath = getSmitheryAuthPath(agentDir);
	try {
		await fs.rm(authPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}
