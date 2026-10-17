import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { disposeAllKernelSessions, executePython } from "@gajae-code/coding-agent/eval/py/executor";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
} from "@gajae-code/coding-agent/eval/py/kernel";
import { checkPythonKernelAvailability, PythonKernel } from "@gajae-code/coding-agent/eval/py/kernel";
import { $which, TempDir, WhichCachePolicy } from "@gajae-code/utils";
import { resolvePythonRuntime, resolveVenvPath } from "../../src/eval/py/runtime";
import { applySessionLaunchEnvironment } from "../../src/sdk/session-environment";

const originalStart = PythonKernel.start;

function snapshotEnv(keys: readonly string[]): Map<string, string | undefined> {
	return new Map(keys.map(key => [key, Bun.env[key]]));
}

function restoreEnv(keys: readonly string[], snapshot: Map<string, string | undefined>): void {
	for (const key of keys) {
		const value = snapshot.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	id = `fake-kernel-${Math.random().toString(36).slice(2)}`;
	alive = true;
	exitCode: number | null = null;
	executeCalls: string[] = [];
	shutdownCalls = 0;
	shutdownResult: KernelShutdownResult = { confirmed: true };
	private readonly executeImpl?: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;

	constructor(executeImpl?: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>) {
		this.executeImpl = executeImpl;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		return this.executeImpl ? await this.executeImpl(code, options) : OK_RESULT;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		return this.shutdownResult;
	}

	isAlive(): boolean {
		return this.alive;
	}

	getExitCode(): number | null {
		return this.exitCode;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(pid: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(25);
	}
	return !isProcessAlive(pid);
}

describe("python eval lifecycle", () => {
	const envKeys = ["PI_PYTHON_SKIP_CHECK"] as const;
	let previousEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		previousEnv = snapshotEnv(envKeys);
	});

	afterEach(async () => {
		PythonKernel.start = originalStart;
		try {
			await disposeAllKernelSessions();
		} finally {
			restoreEnv(envKeys, previousEnv);
		}
	});

	it("does not rediscover virtualenvs removed from the effective session environment", async () => {
		using tempDir = TempDir.createSync("@gjc-python-session-venv-");
		const venvPath = path.join(tempDir.path(), "ambient-venv");
		const binDir = path.join(venvPath, process.platform === "win32" ? "Scripts" : "bin");
		const venvPython = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		await fs.mkdir(binDir, { recursive: true });
		await fs.writeFile(venvPython, "fixture interpreter");

		const envKeys = ["VIRTUAL_ENV", "CONDA_PREFIX"] as const;
		const previousEnv = snapshotEnv(envKeys);
		try {
			Bun.env.VIRTUAL_ENV = venvPath;
			Bun.env.CONDA_PREFIX = venvPath;
			const effectiveEnv: Record<string, string | undefined> = {
				PATH: Bun.env.PATH,
				VIRTUAL_ENV: venvPath,
				CONDA_PREFIX: venvPath,
			};
			applySessionLaunchEnvironment(effectiveEnv, { unsetEnv: [...envKeys] });

			expect(resolveVenvPath(tempDir.path(), effectiveEnv)).toBeUndefined();
			const runtime = resolvePythonRuntime(tempDir.path(), effectiveEnv);
			expect(runtime.pythonPath).not.toBe(venvPython);
			expect(runtime.venvPath).not.toBe(venvPath);
		} finally {
			restoreEnv(envKeys, previousEnv);
		}
	});

	it("resolves Python from the session PATH and bypasses a cached miss", async () => {
		using tempDir = TempDir.createSync("@gjc-python-session-path-");
		const binDir = path.join(tempDir.path(), "session-bin");
		const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		const python3Path = path.join(binDir, process.platform === "win32" ? "python3.exe" : "python3");
		await fs.mkdir(binDir, { recursive: true });
		expect($which("python", { PATH: binDir, cache: WhichCachePolicy.Fresh })).toBeNull();
		await fs.writeFile(pythonPath, "#!/bin/sh\nexit 0\n");
		await fs.writeFile(python3Path, "#!/bin/sh\nexit 0\n");
		if (process.platform !== "win32") {
			await fs.chmod(pythonPath, 0o755);
			await fs.chmod(python3Path, 0o755);
		}

		const effectiveEnv: Record<string, string | undefined> = { PATH: Bun.env.PATH };
		applySessionLaunchEnvironment(effectiveEnv, { env: { PATH: binDir } });
		const runtime = resolvePythonRuntime(tempDir.path(), effectiveEnv, { managedWorkspaceVenv: true });
		expect(runtime.pythonPath).toBe(pythonPath);

		await fs.rm(pythonPath);
		const python3Runtime = resolvePythonRuntime(tempDir.path(), effectiveEnv, { managedWorkspaceVenv: true });
		expect(python3Runtime.pythonPath).toBe(python3Path);
	});

	it("resolves mixed-case virtual environment names on Windows", async () => {
		if (process.platform !== "win32") return;
		using tempDir = TempDir.createSync("@gjc-python-session-windows-venv-");
		const venvPath = path.join(tempDir.path(), "session-venv");
		const pythonPath = path.join(venvPath, "Scripts", "python.exe");
		await fs.mkdir(path.dirname(pythonPath), { recursive: true });
		await fs.writeFile(pythonPath, "fixture interpreter");

		const effectiveEnv: Record<string, string | undefined> = {
			PATH: "",
			VIRTUAL_ENV: path.join(tempDir.path(), "inherited-venv"),
		};
		applySessionLaunchEnvironment(effectiveEnv, { env: { Virtual_Env: venvPath } });

		const runtime = resolvePythonRuntime(tempDir.path(), effectiveEnv, { managedWorkspaceVenv: true });
		expect(runtime.venvPath).toBe(venvPath);
		expect(runtime.pythonPath).toBe(pythonPath);
		expect(runtime.env.Virtual_Env).toBe(venvPath);
		expect(runtime.env.VIRTUAL_ENV).toBeUndefined();
		expect(resolveVenvPath(tempDir.path(), { Conda_Prefix: venvPath })).toBe(venvPath);
	});

	it("coalesces concurrent first acquires for the same session into one kernel", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const startup = Promise.withResolvers<void>();
		let startCalls = 0;
		const kernel = new FakeKernel();
		PythonKernel.start = async () => {
			startCalls += 1;
			await startup.promise;
			return kernel as unknown as PythonKernel;
		};

		const first = executePython("print('first')", {
			cwd: tempDir.path(),
			sessionId: "concurrent-session",
			kernelMode: "session",
		});
		const second = executePython("print('second')", {
			cwd: tempDir.path(),
			sessionId: "concurrent-session",
			kernelMode: "session",
		});
		await Bun.sleep(0);
		expect(startCalls).toBe(1);

		startup.resolve();
		await Promise.all([first, second]);

		expect(startCalls).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('first')", "print('second')"]);
	});

	it("settles pending executions and releases abort listeners during shutdown", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const controller = new AbortController();
		let abortListeners = 0;
		const originalAdd = controller.signal.addEventListener.bind(controller.signal);
		const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = ((
			type: string,
			listener: Parameters<typeof originalAdd>[1],
			options?: AddEventListenerOptions | boolean,
		) => {
			if (type === "abort") abortListeners += 1;
			return originalAdd(type, listener, options);
		}) as typeof controller.signal.addEventListener;
		controller.signal.removeEventListener = ((
			type: string,
			listener: Parameters<typeof originalRemove>[1],
			options?: EventListenerOptions | boolean,
		) => {
			if (type === "abort") abortListeners -= 1;
			return originalRemove(type, listener, options);
		}) as typeof controller.signal.removeEventListener;

		const kernel = await originalStart({ cwd: tempDir.path() });
		try {
			const execution = kernel.execute("import time\ntime.sleep(60)", {
				signal: controller.signal,
				timeoutMs: 60_000,
			});
			for (let i = 0; i < 40 && abortListeners === 0; i += 1) {
				await Bun.sleep(50);
			}
			expect(abortListeners).toBe(1);

			await kernel.shutdown({ timeoutMs: 100 });
			const result = await execution;
			expect(result.status).toBe("error");
			expect(result.cancelled).toBe(true);
			expect(result.kernelKilled).toBe(true);
			expect(abortListeners).toBe(0);
		} finally {
			await kernel.shutdown({ timeoutMs: 100 }).catch(() => undefined);
		}
	});

	it("treats clean exit code 0 as confirmed shutdown and does not reinsert the session", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const firstKernel = new FakeKernel();
		const secondKernel = new FakeKernel();
		let startCalls = 0;
		PythonKernel.start = async () => {
			startCalls += 1;
			return (startCalls === 1 ? firstKernel : secondKernel) as unknown as PythonKernel;
		};

		await executePython("print('one')", {
			cwd: tempDir.path(),
			sessionId: "clean-exit-session",
			kernelMode: "session",
		});
		await disposeAllKernelSessions();
		await executePython("print('two')", {
			cwd: tempDir.path(),
			sessionId: "clean-exit-session",
			kernelMode: "session",
		});

		expect(firstKernel.shutdownCalls).toBe(1);
		expect(startCalls).toBe(2);
		expect(secondKernel.executeCalls).toEqual(["print('two')"]);
	});

	it("kills background descendants owned by a bash cell interrupt while an unrelated sibling survives", async () => {
		if (process.platform === "win32") return;
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-lifecycle-");
		const unrelated = Bun.spawn(["/bin/sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
		let childPid: number | undefined;
		try {
			const resultPromise = executePython("%%bash\n(sleep 30) &\necho child:$!\nwait", {
				cwd: tempDir.path(),
				sessionId: "bash-descendant-session",
				kernelMode: "session",
				timeoutMs: 500,
			});
			const result = await resultPromise;
			const match = result.output.match(/child:(\d+)/);
			expect(match).not.toBeNull();
			childPid = Number(match?.[1]);
			expect(result.cancelled).toBe(true);
			expect(await waitForExit(childPid)).toBe(true);
			expect(isProcessAlive(unrelated.pid)).toBe(true);
		} finally {
			try {
				unrelated.kill("SIGKILL");
			} catch {
				// ignore cleanup races
			}
			await unrelated.exited.catch(() => undefined);
		}
	});
});
describe("python kernel env-var dual-read (GJC_* preferred, PI_* fallback)", () => {
	// `checkPythonKernelAvailability` short-circuits on `isBunTestRuntime()`
	// (NODE_ENV/BUN_ENV === "test"), which would mask the skip-check branch.
	// These tests neutralize the test-runtime guard inside a scoped window and
	// restore it in finally so the real GJC/PI skip-check branch is exercised.
	const envKeys = [
		"GJC_PYTHON_SKIP_CHECK",
		"PI_PYTHON_SKIP_CHECK",
		"GJC_PYTHON_IPC_TRACE",
		"PI_PYTHON_IPC_TRACE",
		"NODE_ENV",
		"BUN_ENV",
	] as const;
	let previousEnv = new Map<string, string | undefined>();

	function clearSkipEnv(): void {
		for (const key of envKeys) delete Bun.env[key];
	}

	function neutralizeTestRuntime(): void {
		// Force isBunTestRuntime() false so the skip-check env var is the
		// sole gate, not the test-runtime short-circuit.
		delete Bun.env.NODE_ENV;
		delete Bun.env.BUN_ENV;
	}

	beforeEach(() => {
		previousEnv = snapshotEnv(envKeys);
	});

	afterEach(() => {
		restoreEnv(envKeys, previousEnv);
	});

	it("restores pre-existing environment values after cleanup", () => {
		const suiteEnv = snapshotEnv(envKeys);
		try {
			for (const key of envKeys) Bun.env[key] = `hostile-${key}`;
			const testEnv = snapshotEnv(envKeys);
			clearSkipEnv();
			restoreEnv(envKeys, testEnv);
			for (const key of envKeys) expect(Bun.env[key]).toBe(`hostile-${key}`);
		} finally {
			restoreEnv(envKeys, suiteEnv);
		}
	});
	it("honors GJC_PYTHON_SKIP_CHECK=1 and returns ok without spawning Python", async () => {
		clearSkipEnv();
		neutralizeTestRuntime();
		Bun.env.GJC_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-skipcheck-gjc-");
		const availability = await checkPythonKernelAvailability(tempDir.path());
		expect(availability.ok).toBe(true);
	});

	it("still honors legacy PI_PYTHON_SKIP_CHECK=1 as a fallback", async () => {
		clearSkipEnv();
		neutralizeTestRuntime();
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-skipcheck-pi-");
		const availability = await checkPythonKernelAvailability(tempDir.path());
		expect(availability.ok).toBe(true);
	});

	it("OR semantics: GJC=0 with PI=1 still skips the check", async () => {
		clearSkipEnv();
		neutralizeTestRuntime();
		Bun.env.GJC_PYTHON_SKIP_CHECK = "0";
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@gjc-python-skipcheck-or-");
		const availability = await checkPythonKernelAvailability(tempDir.path());
		expect(availability.ok).toBe(true);
	});

	it("accepts truthy tokens true/yes for GJC_PYTHON_SKIP_CHECK (case-insensitive)", async () => {
		clearSkipEnv();
		neutralizeTestRuntime();
		Bun.env.GJC_PYTHON_SKIP_CHECK = "YES";
		using tempDir = TempDir.createSync("@gjc-python-skipcheck-yes-");
		const availability = await checkPythonKernelAvailability(tempDir.path());
		expect(availability.ok).toBe(true);
	});
});
