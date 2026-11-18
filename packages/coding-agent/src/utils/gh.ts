import { projectSafeSpawnEnv } from "@gajae-code/utils/shell-config";

const DEFAULT_GH_TIMEOUT_MS = 5_000;

export interface GhResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

/**
 * Environment for every `gh` GJC starts: project-dotenv hook variables dropped
 * (gh runs git), and captured output never paged or treated as a terminal.
 */
export function ghSpawnEnv(): Record<string, string> {
	const env = projectSafeSpawnEnv();
	delete env.GH_FORCE_TTY;
	env.GH_PAGER = "cat";
	return env;
}

export type RunGh = (args: string[], options?: { timeoutMs?: number }) => Promise<GhResult>;

/** Run GitHub CLI without allowing it to consume the parent terminal's input. */
export async function runGhDefault(args: string[], options?: { timeoutMs?: number }): Promise<GhResult> {
	const ghPath = Bun.which("gh");
	if (!ghPath) {
		return { exitCode: -1, stdout: "", stderr: "gh not found", timedOut: false };
	}
	const timeoutMs = options?.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
	let timedOut = false;
	try {
		const proc = Bun.spawn([ghPath, ...args], { env: ghSpawnEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			return { exitCode, stdout, stderr, timedOut };
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		return { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut };
	}
}
