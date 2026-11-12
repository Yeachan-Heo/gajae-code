import { extractStructuredApiKeyToken } from "@gajae-code/ai/core";
import type { AuthStorage } from "../session/auth-storage";

/** Credential bytes stay in-process. This neither resolves keys nor refreshes OAuth. */
export function collectSdkStoredSecrets(authStorage: AuthStorage): string[] {
	const secrets = new Set<string>();
	for (const entry of Object.values(authStorage.getAll())) {
		for (const credential of Array.isArray(entry) ? entry : [entry]) {
			if (credential.type === "api_key") {
				if (credential.key) secrets.add(credential.key);
				const token = extractStructuredApiKeyToken(credential.key);
				if (token) secrets.add(token);
			} else {
				if (credential.access) secrets.add(credential.access);
				if (credential.refresh) secrets.add(credential.refresh);
			}
		}
	}
	return [...secrets];
}
