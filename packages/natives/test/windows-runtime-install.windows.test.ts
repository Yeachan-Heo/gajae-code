import { dlopen, ptr } from "bun:ffi";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const isWindows = process.platform === "win32";
const repoRoot = path.resolve(import.meta.dir, "../../..");
const nativesEntryUrl = url.pathToFileURL(path.join(repoRoot, "packages/natives/native/index.js")).href;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const JOB_MEMORY_HEADROOM_BYTES = 256n * 1024n * 1024n;
const LIVE_TEST_TIMEOUT_MS = 90_000;

setDefaultTimeout(LIVE_TEST_TIMEOUT_MS);

function win32Error(api: { symbols: { GetLastError: () => number } }, operation: string): Error {
	return new Error(`${operation} failed with Win32 error ${api.symbols.GetLastError()}`);
}

async function waitForFile(filePath: string, exited: Promise<number>): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (await Bun.file(filePath).exists()) return;
		if (await Promise.race([exited.then(() => true), Bun.sleep(10).then(() => false)])) {
			throw new Error("child exited before signaling readiness");
		}
	}
	throw new Error("child did not signal readiness before timeout");
}

describe("Windows constrained-memory native runtime install", () => {
	const skipReason = isWindows ? "" : ` (skipped on ${process.platform}: requires Windows Job Objects)`;

	it.skipIf(!isWindows)(`installs Tokio and Rayon safely before first grep use${skipReason}`, async () => {
		const kernel32 = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
			SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "bool" },
			OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
			AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
			TerminateJobObject: { args: ["ptr", "u32"], returns: "bool" },
			CloseHandle: { args: ["ptr"], returns: "bool" },
			GetLastError: { args: [], returns: "u32" },
		});
		const psapi = dlopen("psapi.dll", {
			GetProcessMemoryInfo: { args: ["ptr", "ptr", "u32"], returns: "bool" },
		});
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-runtime-job-"));
		const readyPath = path.join(root, "ready");
		const releasePath = path.join(root, "release");
		const fixtureRoot = path.join(root, "fixture");
		const firstFile = path.join(fixtureRoot, "entry-0000.txt");
		let jobHandle: ReturnType<typeof kernel32.symbols.CreateJobObjectW> | undefined;
		let processHandle: ReturnType<typeof kernel32.symbols.OpenProcess> | undefined;
		let child: ReturnType<typeof Bun.spawn> | undefined;
		let childExited: Promise<number> | undefined;
		let processFinished = false;

		try {
			await fs.mkdir(fixtureRoot);
			await Promise.all(
				Array.from({ length: 300 }, (_, index) => {
					const contents = index === 0 ? "ASYNC_GREP_NEEDLE\nRAYON_GREP_NEEDLE\n" : `fixture row ${index}\n`;
					return fs.writeFile(path.join(fixtureRoot, `entry-${String(index).padStart(4, "0")}.txt`), contents);
				}),
			);

			const childCode = `
(async () => {
	const fs = await import("node:fs/promises");
	const readyPath = ${JSON.stringify(readyPath)};
	const releasePath = ${JSON.stringify(releasePath)};
	const fixtureRoot = ${JSON.stringify(fixtureRoot)};
	await fs.writeFile(readyPath, "ready");
	while (!(await Bun.file(releasePath).exists())) await Bun.sleep(10);

	const native = await import(${JSON.stringify(nativesEntryUrl)});
	const probe = native.probeWindowsJobMemory();
	if (probe.kind !== "job_snapshot" || probe.isInJob !== true) {
		throw new Error("child was not running inside the configured Job Object: " + JSON.stringify(probe));
	}
	if (typeof probe.jobMemoryLimitBytes !== "string" || BigInt(probe.jobMemoryLimitBytes) <= 0n) {
		throw new Error("Job Object memory limit was not observed: " + JSON.stringify(probe));
	}

	const first = await native.grep({ pattern: "ASYNC_GREP_NEEDLE", path: ${JSON.stringify(firstFile)} });
	if (first.totalMatches !== 1 || first.matches.length !== 1) {
		throw new Error("first async grep returned an unexpected result: " + JSON.stringify(first));
	}
	const rayon = await native.grep({
		pattern: "RAYON_GREP_NEEDLE",
		path: fixtureRoot,
		cache: true,
		hidden: false,
		gitignore: false,
	});
	if (rayon.totalMatches !== 1 || rayon.matches.length !== 1) {
		throw new Error("cached directory grep returned an unexpected result: " + JSON.stringify(rayon));
	}
	console.log(JSON.stringify({ runtimeJob: probe.kind, firstMatches: first.totalMatches, rayonMatches: rayon.totalMatches }));
})().catch(error => {
	console.error(error && error.stack ? error.stack : String(error));
	process.exitCode = 1;
});
`;
			child = Bun.spawn([process.execPath, "-e", childCode], {
				cwd: repoRoot,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			childExited = child.exited.finally(() => {
				processFinished = true;
			});
			const stdout = new Response(child.stdout).text();
			const stderr = new Response(child.stderr).text();
			await waitForFile(readyPath, childExited);

			processHandle = kernel32.symbols.OpenProcess(
				PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
				false,
				child.pid,
			);
			if (Number(processHandle) === 0) throw win32Error(kernel32, "OpenProcess");

			const counters = new ArrayBuffer(80);
			const countersView = new DataView(counters);
			countersView.setUint32(0, counters.byteLength, true);
			if (!psapi.symbols.GetProcessMemoryInfo(processHandle, ptr(new Uint8Array(counters)), counters.byteLength)) {
				throw win32Error(kernel32, "GetProcessMemoryInfo");
			}
			const workingSetBytes = countersView.getBigUint64(16, true);
			const jobMemoryLimitBytes = workingSetBytes + JOB_MEMORY_HEADROOM_BYTES;
			const jobInformation = new ArrayBuffer(144);
			const jobView = new DataView(jobInformation);
			jobView.setUint32(16, JOB_OBJECT_LIMIT_JOB_MEMORY, true);
			jobView.setBigUint64(120, jobMemoryLimitBytes, true);

			jobHandle = kernel32.symbols.CreateJobObjectW(null, null);
			if (Number(jobHandle) === 0) throw win32Error(kernel32, "CreateJobObjectW");
			if (
				!kernel32.symbols.SetInformationJobObject(
					jobHandle,
					JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
					ptr(new Uint8Array(jobInformation)),
					jobInformation.byteLength,
				)
			) {
				throw win32Error(kernel32, "SetInformationJobObject");
			}
			if (!kernel32.symbols.AssignProcessToJobObject(jobHandle, processHandle)) {
				throw win32Error(kernel32, "AssignProcessToJobObject");
			}

			await fs.writeFile(releasePath, "run");
			const exitCode = await childExited;
			const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
			expect(exitCode, `child stdout:\n${stdoutText}\nchild stderr:\n${stderrText}`).toBe(0);
			expect(stderrText).not.toMatch(/os error 1455|failed to spawn thread|panicked/i);
			expect(JSON.parse(stdoutText.trim())).toEqual({
				runtimeJob: "job_snapshot",
				firstMatches: 1,
				rayonMatches: 1,
			});
		} finally {
			if (child && !processFinished) {
				if (jobHandle && Number(jobHandle) !== 0) kernel32.symbols.TerminateJobObject(jobHandle, 1);
				else child.kill();
				if (childExited) await Promise.race([childExited, Bun.sleep(5_000)]);
			}
			if (processHandle && Number(processHandle) !== 0) kernel32.symbols.CloseHandle(processHandle);
			if (jobHandle && Number(jobHandle) !== 0) kernel32.symbols.CloseHandle(jobHandle);
			kernel32.close();
			psapi.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
