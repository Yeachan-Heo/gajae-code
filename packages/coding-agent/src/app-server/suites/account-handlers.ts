import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { ModelRegistry } from "../../config/model-registry";
import { AuthStorage } from "../../session/auth-storage";
import type { AccountAuthStateSource, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;

const invalidParams = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const internalError = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAgentDirectory(): string {
	const configured =
		process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? undefined;
	return path.resolve(configured ?? getAgentDir());
}

function hasApiKeyCredential(value: unknown): boolean {
	return isRecord(value) && value.type === "api_key";
}

function hasStoredApiKey(authStorage: AuthStorage, providers: ReadonlySet<string>): boolean {
	return Object.entries(authStorage.getAll()).some(([provider, value]) => {
		if (!providers.has(provider) || authStorage.hasOAuth(provider)) return false;
		return Array.isArray(value) ? value.some(hasApiKeyCredential) : hasApiKeyCredential(value);
	});
}

/**
 * Return true when GJC has an API-key style credential for at least one loaded provider.
 *
 * ChatGPT OAuth is deliberately not translated to the `apiKey` account variant. The
 * app-server account contract has no generic OAuth variant, and a generic OAuth token
 * must not be presented as a ChatGPT-linked account.
 */
function hasConfiguredApiKey(authStorage: AuthStorage, modelRegistry: ModelRegistry): boolean {
	const providers = new Set(modelRegistry.getAll().map(model => model.provider));
	if (hasStoredApiKey(authStorage, providers)) return true;

	for (const provider of providers) {
		if (!modelRegistry.hasConfiguredProviderAuth(provider)) continue;
		if (authStorage.hasOAuth(provider)) continue;
		// This covers API keys supplied through models.yml, environment variables, or
		// a runtime/config override. Keyless providers report false from hasAuth().
		if (authStorage.hasAuth(provider)) return true;
	}
	return false;
}

/**
 * account/read is a truthful projection of GJC's provider auth state. GJC does not
 * maintain ChatGPT accounts, so the only account variant it can expose is apiKey;
 * otherwise the response explicitly carries no linked account and never asks the
 * client to perform OpenAI login.
 */
export const productionAccountAuthState: AccountAuthStateSource = async () => {
	const agentDir = resolveAgentDirectory();
	let authStorage: AuthStorage | undefined;
	try {
		await fs.mkdir(agentDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
		return hasConfiguredApiKey(authStorage, modelRegistry);
	} finally {
		authStorage?.close();
	}
};

export const accountReadHandler: MethodHandler = async (params, context) => {
	if (params !== undefined && params !== null) {
		if (!isRecord(params)) return invalidParams();
		if (params.refreshToken !== undefined && typeof params.refreshToken !== "boolean") return invalidParams();
	}

	try {
		const hasApiKey = await (context?.accountAuthState ?? productionAccountAuthState)();
		return {
			ok: true,
			result: {
				account: hasApiKey ? { type: "apiKey" } : null,
				requiresOpenaiAuth: false,
			},
		};
	} catch {
		return internalError();
	}
};

export const accountHandlers: Record<string, MethodHandler> = {
	"account/read": accountReadHandler,
};
