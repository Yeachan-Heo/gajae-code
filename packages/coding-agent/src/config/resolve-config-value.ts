/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * Note: command execution is async to avoid blocking the TUI.
 */

import type { executeShell as executeShellFn } from "@gajae-code/natives";

let executeShellLoad: Promise<typeof executeShellFn> | undefined;

async function executeShellNative(): Promise<typeof executeShellFn> {
	executeShellLoad ??= Promise.resolve(
		(require("@gajae-code/natives") as { executeShell: typeof executeShellFn }).executeShell,
	);
	return await executeShellLoad;
}

/** Cache for successful shell command results (persists for process lifetime). */
const commandResultCache = new Map<string, string>();

/** De-duplicates concurrent executions for the same command. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 * - `cacheScope` isolates command-cache entries when a caller rotates its config
 */
export async function resolveConfigValue(config: string, cacheScope?: string): Promise<string | undefined> {
	if (config.startsWith("!")) {
		return await executeCommand(config, cacheScope);
	}
	const envValue = process.env[config];
	return envValue || config;
}

async function executeCommand(commandConfig: string, cacheScope?: string): Promise<string | undefined> {
	const cacheKey = cacheScope === undefined ? commandConfig : `${cacheScope}\u0000${commandConfig}`;
	const cached = commandResultCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const existing = commandInFlight.get(cacheKey);
	if (existing) {
		return await existing;
	}

	const command = commandConfig.slice(1);
	const promise = runShellCommand(command, 10_000)
		.then(result => {
			if (result !== undefined) {
				commandResultCache.set(cacheKey, result);
			}
			return result;
		})
		.finally(() => {
			commandInFlight.delete(cacheKey);
		});

	commandInFlight.set(cacheKey, promise);
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number): Promise<string | undefined> {
	try {
		const executeShell = await executeShellNative();
		let output = "";
		const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
			if (!err) {
				output += chunk;
			}
		});
		if (result.timedOut || result.exitCode !== 0) {
			return undefined;
		}
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveHeaders(
	headers: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = await resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	commandInFlight.clear();
}
