import * as os from "node:os";
import * as path from "node:path";
import { enrichModelThinking } from "@gajae-code/ai/model-thinking";
import type { Model } from "@gajae-code/ai/types";
import { isEnoent } from "@gajae-code/utils";

export async function withEnv(
	overrides: Record<string, string | undefined>,
	fn: () => void | Promise<void>,
): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(overrides)) {
		previous.set(key, Bun.env[key]);
	}
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		await fn();
	} finally {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

export async function waitForDelayOrAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		const reason = signal.reason;
		throw reason instanceof Error ? reason : new Error(String(reason ?? "request aborted"));
	}

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => resolve(), delayMs);
	const onAbort = () => {
		const reason = signal?.reason;
		reject(reason instanceof Error ? reason : new Error(String(reason ?? "request aborted")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createCodexModel(id: string): Model<"openai-codex-responses"> {
	return enrichModelThinking({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

export interface AuthGatewayE2EStatus {
	ok: boolean;
	token?: string;
	reason?: string;
}

export interface AuthGatewayE2ERequirements {
	provider: string;
	modelId: string;
}

export const AUTH_GATEWAY_E2E_URL = Bun.env.GJC_E2E_GATEWAY_URL ?? "http://127.0.0.1:4000";

const AUTH_GATEWAY_TOKEN_PATH = path.join(os.homedir(), ".gjc", "auth-gateway.token");
const AUTH_GATEWAY_HEALTH_TIMEOUT_MS = 500;

const authGatewayE2EStatus = new Map<string, Promise<AuthGatewayE2EStatus>>();

export function checkAuthGatewayE2EAvailable(requirements: AuthGatewayE2ERequirements): Promise<AuthGatewayE2EStatus> {
	const key = `${requirements.provider}\u0000${requirements.modelId}`;
	let status = authGatewayE2EStatus.get(key);
	if (!status) {
		status = readAuthGatewayE2EStatus(requirements);
		authGatewayE2EStatus.set(key, status);
	}
	return status;
}

async function readAuthGatewayE2EStatus(requirements: AuthGatewayE2ERequirements): Promise<AuthGatewayE2EStatus> {
	if (!Bun.env.E2E) return { ok: false, reason: "E2E env not set" };
	let token: string;
	try {
		token = (await Bun.file(AUTH_GATEWAY_TOKEN_PATH).text()).trim();
	} catch (err) {
		if (isEnoent(err)) return { ok: false, reason: `no token at ${AUTH_GATEWAY_TOKEN_PATH}` };
		throw err;
	}
	if (!token) return { ok: false, reason: `empty token at ${AUTH_GATEWAY_TOKEN_PATH}` };

	try {
		const res = await fetch(`${AUTH_GATEWAY_E2E_URL}/healthz`, {
			signal: AbortSignal.timeout(AUTH_GATEWAY_HEALTH_TIMEOUT_MS),
		});
		if (!res.ok) return { ok: false, reason: `healthz returned ${res.status}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `healthz unreachable: ${msg}` };
	}
	try {
		const res = await fetch(`${AUTH_GATEWAY_E2E_URL}/v1/models`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(AUTH_GATEWAY_HEALTH_TIMEOUT_MS),
		});
		if (!res.ok) return { ok: false, reason: `models returned ${res.status}` };
		const payload = (await res.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
		const rows = Array.isArray(payload.data) ? payload.data : [];
		const scopedRows = rows.filter(row => row.owned_by === requirements.provider);
		if (scopedRows.length === 0) {
			return { ok: false, reason: `gateway scope ${requirements.provider} is unavailable` };
		}
		if (!scopedRows.some(row => row.id === requirements.modelId)) {
			return { ok: false, reason: `model ${requirements.modelId} is unavailable in scope ${requirements.provider}` };
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `models probe failed: ${msg}` };
	}
	return { ok: true, token };
}
