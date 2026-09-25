import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createWalkerPoolFixture,
	removeWalkerPoolFixture,
	type WalkerPoolFixture,
} from "./walker-pool-unavailable-fixture";

const isWindows = process.platform === "win32";
const JOB_MEMORY_HEADROOM_BYTES = 256 * 1024 * 1024;
setDefaultTimeout(60_000);

let fixture: WalkerPoolFixture;

function assignMemoryLimitedJob(pid: number, workingSetBytes: number): () => void {
	const kernel = dlopen("kernel32.dll", {
		CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	let job: ReturnType<typeof kernel.symbols.CreateJobObjectW> = null;
	let processHandle: ReturnType<typeof kernel.symbols.OpenProcess> = null;
	try {
		job = kernel.symbols.CreateJobObjectW(null, null);
		if (!job) throw new Error(`CreateJobObjectW failed: ${kernel.symbols.GetLastError()}`);
		processHandle = kernel.symbols.OpenProcess(0x0001 | 0x0100 | 0x0400, 0, pid);
		if (!processHandle) throw new Error(`OpenProcess failed: ${kernel.symbols.GetLastError()}`);

		const limits = new Uint8Array(144);
		const view = new DataView(limits.buffer);
		view.setUint32(16, 0x00000200, true); // JOB_OBJECT_LIMIT_JOB_MEMORY
		view.setBigUint64(120, BigInt(workingSetBytes + JOB_MEMORY_HEADROOM_BYTES), true);
		if (!kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) {
			throw new Error(`SetInformationJobObject failed: ${kernel.symbols.GetLastError()}`);
		}
		if (!kernel.symbols.AssignProcessToJobObject(job, processHandle)) {
			throw new Error(`AssignProcessToJobObject failed: ${kernel.symbols.GetLastError()}`);
		}

		const assignedJob = job;
		const assignedProcess = processHandle;
		return () => {
			kernel.symbols.CloseHandle(assignedProcess);
			kernel.symbols.CloseHandle(assignedJob);
			kernel.close();
		};
	} catch (error) {
		if (processHandle) kernel.symbols.CloseHandle(processHandle);
		if (job) kernel.symbols.CloseHandle(job);
		kernel.close();
		throw error;
	}
}

async function waitForReadyFile(child: ReturnType<typeof Bun.spawn>): Promise<{ rss: number }> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await fs.readFile(fixture.readyFile, "utf8")) as { rss: number };
		} catch {
			if (child.exitCode !== null) throw new Error(`walker probe exited before readiness: ${child.exitCode}`);
			await Bun.sleep(10);
		}
	}
	throw new Error("walker probe did not reach its pre-traversal readiness point");
}

beforeAll(async () => {
	if (isWindows) fixture = await createWalkerPoolFixture();
});

afterAll(async () => {
	if (fixture) await removeWalkerPoolFixture(fixture);
});

describe.skipIf(!isWindows)("Windows Job Object walker pool failure (skipped off Windows)", () => {
	it("completes a 512-file glob serially without thread or memory failure", async () => {
		await fs.rm(fixture.readyFile, { force: true });
		await fs.rm(fixture.startFile, { force: true });
		await fs.rm(fixture.resultFile, { force: true });
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "walker-pool-unavailable-child.ts")], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			env: {
				...process.env,
				PI_WALK_WORKERS: "4",
				PI_WALKER_TEST_FORCE_POOL_UNAVAILABLE: "1",
				WALKER_TEST_ROOT: fixture.root,
				WALKER_TEST_WARM_ROOT: fixture.warmRoot,
				WALKER_TEST_READY_FILE: fixture.readyFile,
				WALKER_TEST_START_FILE: fixture.startFile,
				WALKER_TEST_RESULT_FILE: fixture.resultFile,
			},
		});
		const stderr = new Response(child.stderr).text();
		let releaseJob: (() => void) | undefined;
		try {
			const ready = await waitForReadyFile(child);
			releaseJob = assignMemoryLimitedJob(child.pid as number, ready.rss);
			await fs.writeFile(fixture.startFile, "start\n");
			const exitCode = await child.exited;
			const errorOutput = await stderr;
			expect(exitCode).toBe(0);
			expect(errorOutput).not.toMatch(/os error 1455|panicked|failed to spawn thread/i);
			const result = JSON.parse(await fs.readFile(fixture.resultFile, "utf8")) as {
				initialStatus: string;
				statusAfterWarmup: string;
				finalStatus: string;
				beforeThreads: number;
				afterThreads: number;
				totalMatches: number;
				actual: string[];
				expected: string[];
				walkerThreadNames: string[];
			};
			expect(result.initialStatus).toBe("uninitialized");
			expect(result.statusAfterWarmup).toBe("uninitialized");
			expect(result.finalStatus).toBe("unavailable");
			expect(result.totalMatches).toBeGreaterThanOrEqual(512);
			expect(result.actual).toEqual(result.expected);
			expect(result.afterThreads).toBeLessThanOrEqual(result.beforeThreads);
			expect(result.walkerThreadNames).toEqual([]);
		} catch (error) {
			child.kill();
			await child.exited;
			throw error;
		} finally {
			releaseJob?.();
		}
	});
});
