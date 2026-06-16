const MACOS_MALLOC_STACK_LOGGING_ENV = new Set(["MallocStackLogging", "MallocStackLoggingNoCompact"]);

export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function shouldForwardSpawnEnvName(name: string): boolean {
	return isSafeEnvName(name) && !MACOS_MALLOC_STACK_LOGGING_ENV.has(name);
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (!shouldForwardSpawnEnvName(key) || value === undefined || !isSafeEnvValue(value)) continue;
		result[key] = value;
	}
	return result;
}
