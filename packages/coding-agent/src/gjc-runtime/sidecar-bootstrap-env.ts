import { canonicalEnvKey, type ProjectEnvSnapshot, projectEnvSnapshot } from "@gajae-code/utils/env-file";

/**
 * Operator environment only. A value that matches the project dotenv snapshot
 * was loaded by Bun from the repository and must not become signing material.
 */
export function trustedCoordinatorEnv(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	snapshot: ProjectEnvSnapshot = projectEnvSnapshot(),
): string | undefined {
	const raw = env[name];
	if (!raw) return undefined;
	const key = canonicalEnvKey(name);
	const declared = snapshot.values[key];
	if (declared !== undefined && (snapshot.dynamic.has(key) || declared === raw)) return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
