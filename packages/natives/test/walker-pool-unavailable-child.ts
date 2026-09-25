import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob, walkerPoolStatus } from "../native/index.js";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing required environment variable ${name}`);
	return value;
}

async function threadSnapshot(): Promise<{ count: number; walkerNames: string[] }> {
	if (process.platform === "linux") {
		return { count: (await fs.readdir(`/proc/${process.pid}/task`)).length, walkerNames: [] };
	}
	if (process.platform === "darwin") {
		const proc = dlopen("/usr/lib/libproc.dylib", {
			proc_pidinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		try {
			const info = new Uint8Array(96);
			const size = proc.symbols.proc_pidinfo(process.pid, 4, 0, ptr(info), info.byteLength);
			if (size !== info.byteLength) throw new Error(`proc_pidinfo task-info size mismatch: ${size}`);
			return { count: new DataView(info.buffer).getInt32(84, true), walkerNames: [] };
		} finally {
			proc.close();
		}
	}
	if (process.platform === "win32") {
		const kernel = dlopen("kernel32.dll", {
			CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
			Thread32First: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			Thread32Next: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			OpenThread: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			GetThreadDescription: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
			lstrlenW: { args: [FFIType.ptr], returns: FFIType.i32 },
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		});
		const snapshot = kernel.symbols.CreateToolhelp32Snapshot(0x00000004, 0);
		if (!snapshot) {
			kernel.close();
			throw new Error("CreateToolhelp32Snapshot returned a null handle");
		}
		try {
			const entry = new Uint8Array(28);
			const view = new DataView(entry.buffer);
			view.setUint32(0, entry.byteLength, true);
			let count = 0;
			const walkerNames: string[] = [];
			let found = kernel.symbols.Thread32First(snapshot, ptr(entry));
			if (!found) throw new Error(`Thread32First failed: ${kernel.symbols.GetLastError()}`);
			while (found) {
				if (view.getUint32(12, true) === process.pid) {
					count++;
					const thread = kernel.symbols.OpenThread(0x0800, 0, view.getUint32(8, true));
					if (thread) {
						try {
							const description = new Uint8Array(8);
							if (kernel.symbols.GetThreadDescription(thread, ptr(description)) === 0) {
								const address = new DataView(description.buffer).getBigUint64(0, true);
								if (address !== 0n) {
									try {
										const length = kernel.symbols.lstrlenW(address);
										if (length < 0) throw new Error("lstrlenW failed for thread description");
										const bytes = toArrayBuffer(address, 0, (length + 1) * 2);
										const units = new Uint16Array(bytes).subarray(0, length);
										const name = Array.from(units, unit => String.fromCharCode(unit)).join("");
										if (name.startsWith("pi-walker-")) walkerNames.push(name);
									} finally {
										kernel.symbols.LocalFree(address);
									}
								}
							}
						} finally {
							kernel.symbols.CloseHandle(thread);
						}
					}
				}
				found = kernel.symbols.Thread32Next(snapshot, ptr(entry));
			}
			return { count, walkerNames };
		} finally {
			kernel.symbols.CloseHandle(snapshot);
			kernel.close();
		}
	}
	throw new Error(`unsupported thread-count platform: ${process.platform}`);
}

async function listTxtFiles(directory: string, prefix = ""): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await listTxtFiles(absolute, relative)));
		else if (entry.isFile() && entry.name.endsWith(".txt")) paths.push(relative);
	}
	return paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

const root = requiredEnv("WALKER_TEST_ROOT");
const warmRoot = requiredEnv("WALKER_TEST_WARM_ROOT");
const readyFile = requiredEnv("WALKER_TEST_READY_FILE");
const startFile = requiredEnv("WALKER_TEST_START_FILE");
const resultFile = requiredEnv("WALKER_TEST_RESULT_FILE");
const initialStatus = walkerPoolStatus();
const warmup = await glob({
	path: warmRoot,
	pattern: "*.txt",
	recursive: false,
	hidden: true,
	gitignore: false,
	cache: false,
	fileType: FileType.File,
});
if (warmup.totalMatches !== 1) throw new Error(`warmup glob returned ${warmup.totalMatches} entries`);
// The phase-0 addon can start Tokio workers on import and Rust caches RUST_MIN_STACK on the first spawn. Keep the deterministic test hook scoped to WALK_POOL; the 2.1 runtime-install order removes this interaction at integration.
const statusAfterWarmup = walkerPoolStatus();
const before = await threadSnapshot();
await fs.writeFile(readyFile, JSON.stringify({ rss: process.memoryUsage().rss }));
while (!(await fs.stat(startFile).then(() => true, () => false))) await Bun.sleep(5);

const result = await glob({
	path: root,
	pattern: "**/*.txt",
	recursive: true,
	hidden: true,
	gitignore: false,
	includeNodeModules: true,
	cache: false,
	fileType: FileType.File,
});
const after = await threadSnapshot();
const actual = result.matches
	.map(entry => entry.path)
	.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const expected = await listTxtFiles(root);
await fs.writeFile(
	resultFile,
	JSON.stringify({
		initialStatus,
		statusAfterWarmup,
		finalStatus: walkerPoolStatus(),
		beforeThreads: before.count,
		afterThreads: after.count,
		walkerThreadNames: after.walkerNames,
		totalMatches: result.totalMatches,
		actual,
		expected,
	}),
);
