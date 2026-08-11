/**
 * Python runtime resolution utilities.
 *
 * Centralizes environment filtering, venv detection, managed workspace venv
 * provisioning, and Python executable resolution for both the shared gateway
 * and local kernel spawning.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $env, $which, getPythonEnvDir, WhichCachePolicy } from "@gajae-code/utils";
import { withFileLock } from "../../config/file-lock";

export const RLM_MANAGED_PYTHON_PACKAGES: readonly string[] = ["numpy", "pandas", "matplotlib", "polars"];

export interface PythonRuntimeOptions {
	/** Create/use <cwd>/.gjc/python-env when no BYO venv/conda env is present. */
	managedWorkspaceVenv?: boolean;
	/** Packages to seed into the managed workspace venv when provisioning it. */
	seedPackages?: readonly string[];
}

export interface PythonRuntimeLifecycleOptions {
	signal?: AbortSignal;
	deadlineMs?: number;
}

const RUNTIME_CANCEL_GRACE_MS = 1_000;
const RUNTIME_PROCESS_TREE_EXIT_TIMEOUT_MS = 5_000;

const DEFAULT_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
	"LD_LIBRARY_PATH",
]);

const WINDOWS_ENV_ALLOWLIST = new Set([
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERDOMAIN_ROAMINGPROFILE",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
]);

const DEFAULT_ENV_DENYLIST = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
]);

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_"];

const CASE_INSENSITIVE_ENV = process.platform === "win32";
const BASE_ENV_ALLOWLIST = new Set([...DEFAULT_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]);

const NORMALIZED_ALLOWLIST = new Set(
	Array.from(BASE_ENV_ALLOWLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_DENYLIST = new Set(
	Array.from(DEFAULT_ENV_DENYLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_ALLOW_PREFIXES = CASE_INSENSITIVE_ENV
	? DEFAULT_ENV_ALLOW_PREFIXES.map(prefix => prefix.toUpperCase())
	: DEFAULT_ENV_ALLOW_PREFIXES;

function normalizeEnvKey(key: string): string {
	return CASE_INSENSITIVE_ENV ? key.toUpperCase() : key;
}

function resolvePathKey(env: Record<string, string | undefined>): string {
	if (!CASE_INSENSITIVE_ENV) return "PATH";
	const match = Object.keys(env).find(candidate => candidate.toLowerCase() === "path");
	return match ?? "PATH";
}

function resolveGlobalManagedPythonEnv(): string {
	return getPythonEnvDir();
}

function resolvePythonCandidateInVenv(venvPath: string): { venvPath: string; pythonPath: string; binDir: string } {
	const binDir = process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
	const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
	return { venvPath, pythonPath, binDir };
}

function resolveManagedPythonCandidate(): { venvPath: string; pythonPath: string; binDir: string } {
	return resolvePythonCandidateInVenv(resolveGlobalManagedPythonEnv());
}

function resolveWorkspaceManagedPythonCandidate(cwd: string): { venvPath: string; pythonPath: string; binDir: string } {
	return resolvePythonCandidateInVenv(path.join(cwd, ".gjc", "python-env"));
}

export interface PythonRuntime {
	/** Path to python executable */
	pythonPath: string;
	/** Filtered environment variables */
	env: Record<string, string | undefined>;
	/** Path to virtual environment, if detected */
	venvPath?: string;
}

function runtimeFromVenv(
	venvPath: string,
	pythonPath: string,
	binDir: string,
	env: Record<string, string | undefined>,
): PythonRuntime {
	env.VIRTUAL_ENV = venvPath;
	const pathKey = resolvePathKey(env);
	const currentPath = env[pathKey];
	env[pathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
	return {
		pythonPath,
		env,
		venvPath,
	};
}

/**
 * Filter environment variables to a safe allowlist for Python subprocesses.
 * Removes sensitive API keys and limits to known-safe variables.
 */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = normalizeEnvKey(key);
		if (NORMALIZED_DENYLIST.has(normalizedKey)) continue;
		if (NORMALIZED_ALLOWLIST.has(normalizedKey)) {
			const destKey = normalizedKey === "PATH" ? "PATH" : key;
			filtered[destKey] = value;
			continue;
		}
		if (NORMALIZED_ALLOW_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Detect virtual environment path from VIRTUAL_ENV or common locations.
 */
export function resolveVenvPath(cwd: string): string | undefined {
	if ($env.VIRTUAL_ENV) return $env.VIRTUAL_ENV;
	if ($env.CONDA_PREFIX) return $env.CONDA_PREFIX;
	const candidates = [path.join(cwd, ".venv"), path.join(cwd, "venv")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function createRuntimeCancellationError(timedOut: boolean): Error {
	const error = new Error(timedOut ? "Python runtime startup timed out" : "Python runtime startup aborted");
	error.name = timedOut ? "TimeoutError" : "AbortError";
	return error;
}

async function waitForRuntimeLifecycle<T>(
	value: Promise<T>,
	lifecycle: PythonRuntimeLifecycleOptions | undefined,
	settleAfterCancellation?: () => boolean,
): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const cleanups: Array<() => void> = [];
	const finish = (callback: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		callback();
	};
	const cancel = (timedOut: boolean): void => {
		if (settleAfterCancellation?.()) return;
		finish(() => reject(createRuntimeCancellationError(timedOut)));
	};
	if (lifecycle?.signal?.aborted) {
		if (!settleAfterCancellation?.()) throw lifecycle.signal.reason ?? createRuntimeCancellationError(false);
	} else if (lifecycle?.signal) {
		const onAbort = (): void => cancel(false);
		lifecycle.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => lifecycle.signal?.removeEventListener("abort", onAbort));
	}
	const remainingMs = lifecycle?.deadlineMs === undefined ? undefined : lifecycle.deadlineMs - Date.now();
	if (remainingMs !== undefined) {
		if (remainingMs <= 0) cancel(true);
		else {
			const timer = setTimeout(() => cancel(true), remainingMs);
			timer.unref();
			cleanups.push(() => clearTimeout(timer));
		}
	}
	void value.then(
		result => finish(() => resolve(result)),
		error => finish(() => reject(error)),
	);
	return await promise;
}

async function runRuntimeCommand(
	cmd: string[],
	cwd: string,
	env: Record<string, string | undefined>,
	description: string,
	lifecycle?: PythonRuntimeLifecycleOptions,
): Promise<void> {
	const spawnEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") spawnEnv[key] = value;
	}
	const proc = Bun.spawn(cmd, {
		cwd,
		env: spawnEnv,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const cleanups: Array<() => void> = [];
	const finish = (callback: () => void): void => {
		while (cleanups.length > 0) cleanups.pop()?.();
		callback();
	};
	let cancellation: { timedOut: boolean } | undefined;
	let windowsTermination: Promise<void> | undefined;
	const terminateWindowsProcessTree = (): void => {
		if (windowsTermination) return;
		const taskkill = Bun.spawn(["taskkill", "/pid", String(proc.pid), "/t", "/f"], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		windowsTermination = taskkill.exited.then(
			() => undefined,
			() => undefined,
		);
	};
	const waitForProcessTreeExit = async (): Promise<boolean> => {
		if (process.platform === "win32") {
			await windowsTermination;
			return true;
		}
		const deadline = Date.now() + RUNTIME_PROCESS_TREE_EXIT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			try {
				process.kill(-proc.pid, 0);
				await Bun.sleep(10);
			} catch {
				return true;
			}
		}
		return false;
	};
	const cancel = (timedOut: boolean): void => {
		if (cancellation) return;
		cancellation = { timedOut };
		const signalProcessTree = (signal: NodeJS.Signals): void => {
			try {
				if (process.platform === "win32") {
					terminateWindowsProcessTree();
				} else {
					process.kill(-proc.pid, signal);
				}
			} catch {
				// The process may have exited between the cancellation check and signal.
			}
		};
		signalProcessTree("SIGTERM");
		const escalation = setTimeout(() => signalProcessTree("SIGKILL"), RUNTIME_CANCEL_GRACE_MS);
		escalation.unref();
		cleanups.push(() => clearTimeout(escalation));
	};
	if (lifecycle?.signal?.aborted) {
		cancel(false);
	} else if (lifecycle?.signal) {
		const onAbort = (): void => cancel(false);
		lifecycle.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => lifecycle.signal?.removeEventListener("abort", onAbort));
	}
	const remainingMs = lifecycle?.deadlineMs === undefined ? undefined : lifecycle.deadlineMs - Date.now();
	if (remainingMs !== undefined) {
		if (remainingMs <= 0) {
			cancel(true);
		} else {
			const timer = setTimeout(() => cancel(true), remainingMs);
			timer.unref();
			cleanups.push(() => clearTimeout(timer));
		}
	}
	void proc.exited.then(async code => {
		const cancelled = cancellation;
		if (cancelled) {
			const processTreeExited = await waitForProcessTreeExit();
			finish(() => {
				const error = createRuntimeCancellationError(cancelled.timedOut);
				if (!processTreeExited)
					error.message += "; Python provisioner process tree did not exit after cancellation";
				reject(error);
			});
			return;
		}
		finish(() => resolve(code));
	});
	let exitCode: number;
	try {
		exitCode = await promise;
	} catch (error) {
		void output.catch(() => undefined);
		throw error;
	}
	const [stdout, stderr] = await output;
	if (exitCode !== 0) {
		const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		throw new Error(`${description} failed with exit code ${exitCode}${text ? `: ${text}` : ""}`);
	}
}

async function ensureWorkspaceManagedVenv(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	seedPackages: readonly string[],
	lifecycle?: PythonRuntimeLifecycleOptions,
): Promise<void> {
	const venvPath = resolveWorkspaceManagedPythonCandidate(cwd).venvPath;
	const lockSignal =
		lifecycle?.deadlineMs === undefined
			? lifecycle?.signal
			: lifecycle.signal
				? AbortSignal.any([lifecycle.signal, AbortSignal.timeout(Math.max(0, lifecycle.deadlineMs - Date.now()))])
				: AbortSignal.timeout(Math.max(0, lifecycle.deadlineMs - Date.now()));
	let lockAcquired = false;
	const provisioning = withFileLock(
		venvPath,
		async () => {
			if (lifecycle?.signal?.aborted) throw lifecycle.signal.reason ?? createRuntimeCancellationError(false);
			if (lifecycle?.deadlineMs !== undefined && lifecycle.deadlineMs <= Date.now())
				throw createRuntimeCancellationError(true);
			await ensureWorkspaceManagedVenvInner(cwd, baseEnv, seedPackages, lifecycle);
		},
		{ retries: Number.POSITIVE_INFINITY, signal: lockSignal, onAcquired: () => (lockAcquired = true) },
	);
	return await waitForRuntimeLifecycle(provisioning, lifecycle, () => lockAcquired);
}

async function ensureWorkspaceManagedVenvInner(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	seedPackages: readonly string[],
	lifecycle?: PythonRuntimeLifecycleOptions,
): Promise<void> {
	const managed = resolveWorkspaceManagedPythonCandidate(cwd);
	if (!fs.existsSync(managed.pythonPath)) {
		const basePython =
			$which("python3", { PATH: baseEnv.PATH, cache: WhichCachePolicy.Bypass }) ??
			$which("python", { PATH: baseEnv.PATH, cache: WhichCachePolicy.Bypass });
		if (!basePython) throw new Error("Python executable not found on PATH");
		await fs.promises.mkdir(path.dirname(managed.venvPath), { recursive: true });
		try {
			await runRuntimeCommand(
				[basePython, "-m", "venv", managed.venvPath],
				cwd,
				baseEnv,
				"Managed Python venv creation",
				lifecycle,
			);
		} catch (error) {
			await fs.promises.rm(managed.venvPath, { recursive: true, force: true });
			throw error;
		}
	}
	if (seedPackages.length === 0) return;
	const markerPath = path.join(managed.venvPath, ".gjc-seeded.json");
	let seeded = false;
	try {
		const marker = JSON.parse(await fs.promises.readFile(markerPath, "utf8")) as { packages?: unknown };
		const packages = Array.isArray(marker.packages) ? marker.packages : [];
		seeded = seedPackages.every(pkg => packages.includes(pkg));
	} catch {
		seeded = false;
	}
	if (seeded) return;
	const runtimeEnv = runtimeFromVenv(managed.venvPath, managed.pythonPath, managed.binDir, { ...baseEnv }).env;
	await runRuntimeCommand(
		[managed.pythonPath, "-m", "pip", "install", "--upgrade", "pip"],
		cwd,
		runtimeEnv,
		"Managed Python pip bootstrap",
		lifecycle,
	);
	await runRuntimeCommand(
		[managed.pythonPath, "-m", "pip", "install", ...seedPackages],
		cwd,
		runtimeEnv,
		"Managed Python package seed",
		lifecycle,
	);
	await fs.promises.writeFile(
		markerPath,
		`${JSON.stringify({ packages: seedPackages, seededAt: new Date().toISOString() }, null, 2)}\n`,
		"utf8",
	);
}

/**
 * Resolve Python runtime including executable path, environment, and venv detection.
 */
export function resolvePythonRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	options: PythonRuntimeOptions = {},
): PythonRuntime {
	const env = { ...baseEnv };
	const venvPath = env.VIRTUAL_ENV ?? resolveVenvPath(cwd);

	if (venvPath) {
		const candidate = resolvePythonCandidateInVenv(venvPath);
		if (fs.existsSync(candidate.pythonPath)) {
			return runtimeFromVenv(candidate.venvPath, candidate.pythonPath, candidate.binDir, env);
		}
	}

	if (options.managedWorkspaceVenv) {
		const workspaceManaged = resolveWorkspaceManagedPythonCandidate(cwd);
		if (fs.existsSync(workspaceManaged.pythonPath)) {
			return runtimeFromVenv(workspaceManaged.venvPath, workspaceManaged.pythonPath, workspaceManaged.binDir, env);
		}
	} else {
		const managed = resolveManagedPythonCandidate();
		if (fs.existsSync(managed.pythonPath)) {
			return runtimeFromVenv(managed.venvPath, managed.pythonPath, managed.binDir, env);
		}
	}

	const pythonPath = $which("python") ?? $which("python3");
	if (!pythonPath) {
		throw new Error("Python executable not found on PATH");
	}
	return {
		pythonPath,
		env,
	};
}

export async function ensurePythonRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	options: PythonRuntimeOptions = {},
	lifecycle?: PythonRuntimeLifecycleOptions,
): Promise<PythonRuntime> {
	if (options.managedWorkspaceVenv) {
		const env = { ...baseEnv };
		const venvPath = env.VIRTUAL_ENV ?? resolveVenvPath(cwd);
		if (venvPath) {
			const candidate = resolvePythonCandidateInVenv(venvPath);
			if (fs.existsSync(candidate.pythonPath)) {
				return runtimeFromVenv(candidate.venvPath, candidate.pythonPath, candidate.binDir, env);
			}
		}
		await ensureWorkspaceManagedVenv(cwd, baseEnv, options.seedPackages ?? RLM_MANAGED_PYTHON_PACKAGES, lifecycle);
	}
	return resolvePythonRuntime(cwd, baseEnv, options);
}
