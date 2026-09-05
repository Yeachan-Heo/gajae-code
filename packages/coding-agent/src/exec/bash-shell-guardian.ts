import { dlopen, FFIType, ptr } from "bun:ffi";
import * as childProcess from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Process as NativeProcess } from "@gajae-code/natives";
import { isCompiledBinary } from "@gajae-code/utils/env";
import { BASH_SHELL_SUPERVISOR_ARG, type BashShellWorkerRequest } from "./bash-shell-worker-protocol";

type NativeProcessBindings = { Process: typeof NativeProcess };
type OwnershipRecord = { pid: number; incarnation: string; darwinUniqueId?: string | null; signature: string };

export function parseOwnershipRecord(line: string): OwnershipRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<OwnershipRecord>;
	if (
		!Number.isSafeInteger(record.pid) ||
		(record.pid ?? 0) <= 0 ||
		typeof record.incarnation !== "string" ||
		(record.darwinUniqueId !== undefined &&
			record.darwinUniqueId !== null &&
			(typeof record.darwinUniqueId !== "string" || !/^\d+$/.test(record.darwinUniqueId))) ||
		typeof record.signature !== "string"
	) {
		return undefined;
	}
	return record as OwnershipRecord;
}

export function retainOwnedProcess<T extends Pick<NativeProcess, "pid" | "incarnation">>(
	owned: Map<string, T>,
	processRef: T,
	guardianPid = process.pid,
): boolean {
	if (processRef.pid === guardianPid) return false;
	owned.set(`${processRef.pid}:${processRef.incarnation}`, processRef);
	return true;
}

export function extendOwnedDarwinAncestry<T extends { uniqueId: bigint; parentUniqueId: bigint }>(
	knownUniqueIds: Set<bigint>,
	candidates: ReadonlyMap<number, T>,
): number[] {
	const addedPids: number[] = [];
	let added = true;
	while (added) {
		added = false;
		for (const [pid, identity] of candidates) {
			if (knownUniqueIds.has(identity.uniqueId) || !knownUniqueIds.has(identity.parentUniqueId)) continue;
			knownUniqueIds.add(identity.uniqueId);
			addedPids.push(pid);
			added = true;
		}
	}
	return addedPids;
}

function authenticateOwnershipRecord(
	line: string,
	ledgerToken: string,
): { processRef?: NativeProcess; darwinUniqueId?: bigint } | undefined {
	const record = parseOwnershipRecord(line);
	if (!record) return undefined;
	const uniqueId = record.darwinUniqueId ?? "";
	const expected = createHmac("sha256", ledgerToken)
		.update(`${record.pid}:${record.incarnation}:${uniqueId}`)
		.digest();
	let received: Buffer;
	try {
		received = Buffer.from(record.signature, "hex");
	} catch {
		return undefined;
	}
	if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) return undefined;
	if (process.platform === "darwin" && !record.darwinUniqueId) return undefined;
	const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
	const owned = Process.fromPid(record.pid);
	return {
		...(owned?.incarnation === record.incarnation ? { processRef: owned } : {}),
		...(record.darwinUniqueId ? { darwinUniqueId: BigInt(record.darwinUniqueId) } : {}),
	};
}

function enableLinuxChildSubreaper(): boolean {
	if (process.platform !== "linux") return true;
	try {
		const libc = dlopen("libc.so.6", {
			prctl: {
				args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
				returns: FFIType.i32,
			},
		});
		const enabled = libc.symbols.prctl(36, 1, 0, 0, 0) === 0;
		libc.close();
		return enabled;
	} catch {
		return false;
	}
}

function findDarwinLedgerHolders(device: number, inode: bigint): NativeProcess[] | undefined {
	if (process.platform !== "darwin") return [];
	try {
		const proc = dlopen("/usr/lib/libproc.dylib", {
			proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			proc_pidfdinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
			proc_pidinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		const capacity = proc.symbols.proc_listallpids(null, 0);
		if (capacity <= 0) {
			proc.close();
			return undefined;
		}
		const pids = new Int32Array(capacity + 64);
		const count = proc.symbols.proc_listallpids(ptr(pids), pids.byteLength);
		const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
		const matches: NativeProcess[] = [];
		for (let index = 0; index < count; index++) {
			const pid = pids[index]!;
			const fdBytes = proc.symbols.proc_pidinfo(pid, 1, 0, null, 0);
			if (fdBytes <= 0) continue;
			const fds = new Uint8Array(fdBytes);
			const readBytes = proc.symbols.proc_pidinfo(pid, 1, 0, ptr(fds), fds.byteLength);
			const fdView = new DataView(fds.buffer);
			for (let offset = 0; offset + 8 <= readBytes; offset += 8) {
				const fd = fdView.getInt32(offset, true);
				const type = fdView.getUint32(offset + 4, true);
				if (type !== 1) continue; // PROX_FDTYPE_VNODE
				const info = new Uint8Array(256);
				const infoBytes = proc.symbols.proc_pidfdinfo(pid, fd, 1, ptr(info), info.byteLength);
				if (infoBytes < 40) continue;
				const infoView = new DataView(info.buffer);
				if (infoView.getUint32(24, true) !== device || infoView.getBigUint64(32, true) !== inode) continue;
				const processRef = Process.fromPid(pid);
				if (processRef) matches.push(processRef);
				break;
			}
		}
		proc.close();
		return matches;
	} catch {
		return undefined;
	}
}

type DarwinAncestryTracker = {
	seed(uniqueId: bigint): void;
	track(processRef: NativeProcess, uniqueId?: bigint): boolean;
	poll(): boolean;
	close(): void;
};

function createDarwinAncestryTracker(owned: Map<string, NativeProcess>): DarwinAncestryTracker | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const proc = dlopen("/usr/lib/libproc.dylib", {
			proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			proc_pidinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		const knownUniqueIds = new Set<bigint>();
		const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
		const uniqueIdentity = (pid: number): { uniqueId: bigint; parentUniqueId: bigint } | undefined => {
			const info = new Uint8Array(56);
			if (proc.symbols.proc_pidinfo(pid, 17, 0, ptr(info), info.byteLength) !== info.byteLength) return undefined;
			const view = new DataView(info.buffer);
			return { uniqueId: view.getBigUint64(16, true), parentUniqueId: view.getBigUint64(24, true) };
		};
		const track = (processRef: NativeProcess, signedUniqueId?: bigint): boolean => {
			const identity = signedUniqueId === undefined ? uniqueIdentity(processRef.pid) : undefined;
			const uniqueId = signedUniqueId ?? identity?.uniqueId;
			if (uniqueId === undefined) return false;
			knownUniqueIds.add(uniqueId);
			retainOwnedProcess(owned, processRef);
			return true;
		};
		return {
			seed(uniqueId) {
				knownUniqueIds.add(uniqueId);
			},
			track,
			poll() {
				const capacity = proc.symbols.proc_listallpids(null, 0);
				if (capacity <= 0) return false;
				const pids = new Int32Array(capacity + 64);
				const count = proc.symbols.proc_listallpids(ptr(pids), pids.byteLength);
				if (count <= 0) return false;
				const candidates = new Map<
					number,
					{ uniqueId: bigint; parentUniqueId: bigint; processRef: NativeProcess }
				>();
				for (let index = 0; index < count; index++) {
					const pid = pids[index]!;
					const processRef = Process.fromPid(pid);
					if (!processRef) continue;
					const identity = uniqueIdentity(pid);
					const after = Process.fromPid(pid);
					if (identity && after?.incarnation === processRef.incarnation) {
						candidates.set(pid, { ...identity, processRef });
					}
				}
				for (const pid of extendOwnedDarwinAncestry(knownUniqueIds, candidates)) {
					retainOwnedProcess(owned, candidates.get(pid)!.processRef);
				}
				return true;
			},
			close() {
				proc.close();
			},
		};
	} catch {
		return undefined;
	}
}

function supervisorArgv(): string[] {
	return isCompiledBinary()
		? [process.execPath, BASH_SHELL_SUPERVISOR_ARG]
		: [process.execPath, path.join(import.meta.dir, "bash-shell-supervisor-entry.ts")];
}

export async function runBashShellGuardian(): Promise<void> {
	if (!enableLinuxChildSubreaper()) throw new Error("Linux child subreaper setup failed.");
	const ownershipFilePath = path.join(os.tmpdir(), `gjc-shell-ownership-${randomUUID()}.jsonl`);
	const ledgerToken = randomUUID().replaceAll("-", "");
	const ledger = await fs.open(ownershipFilePath, "a+", 0o600);
	const ledgerStat = await ledger.stat({ bigint: true });
	if (
		process.platform === "darwin" &&
		!findDarwinLedgerHolders(Number(ledgerStat.dev), ledgerStat.ino)?.some(holder => holder.pid === process.pid)
	) {
		await ledger.close();
		await fs.rm(ownershipFilePath, { force: true });
		throw new Error("Darwin ownership descriptor discovery is unavailable.");
	}
	const ownedProcesses = new Map<string, NativeProcess>();
	const darwinTracker = createDarwinAncestryTracker(ownedProcesses);
	if (process.platform === "darwin" && !darwinTracker) {
		await ledger.close();
		await fs.rm(ownershipFilePath, { force: true });
		throw new Error("Darwin unique-ancestry tracking is unavailable.");
	}
	if (darwinTracker) {
		const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
		const guardian = Process.fromPid(process.pid);
		if (!guardian || !darwinTracker.track(guardian)) {
			darwinTracker.close();
			await ledger.close();
			await fs.rm(ownershipFilePath, { force: true });
			throw new Error("Darwin guardian ancestry registration failed.");
		}
	}
	const [executable, ...args] = supervisorArgv();
	const supervisor = childProcess.spawn(executable!, args, {
		detached: process.platform !== "win32",
		env: process.env,
		stdio: ["pipe", "inherit", "inherit"],
		windowsHide: true,
	});
	const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	input.on("line", line => {
		let forwarded = line;
		try {
			const request = JSON.parse(line) as BashShellWorkerRequest;
			if (request.type === "init") {
				forwarded = JSON.stringify({
					...request,
					ownershipLedger: { path: ownershipFilePath, token: ledgerToken },
				});
			}
		} catch {}
		if (supervisor.stdin.writable) supervisor.stdin.write(`${forwarded}\n`);
	});
	input.once("close", () => supervisor.stdin.end());
	let cleaning: Promise<void> | undefined;
	let ledgerBuffer = "";
	let ownershipScan = Promise.resolve(true);
	const scanOwnership = (): Promise<boolean> => {
		ownershipScan = ownershipScan.then(async previousOk => {
			if (!previousOk) return false;
			let content: string;
			try {
				content = await ledger.readFile({ encoding: "utf8" });
			} catch {
				return false;
			}
			ledgerBuffer += content;
			const lines = ledgerBuffer.split("\n");
			ledgerBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				const owned = authenticateOwnershipRecord(line, ledgerToken);
				if (owned?.darwinUniqueId && darwinTracker) darwinTracker.seed(owned.darwinUniqueId);
				if (owned?.processRef && darwinTracker && !darwinTracker.track(owned.processRef, owned.darwinUniqueId))
					return false;
				if (owned?.processRef && !darwinTracker) retainOwnedProcess(ownedProcesses, owned.processRef);
			}
			if (darwinTracker) {
				if (!darwinTracker.poll()) return false;
			}
			return true;
		});
		return ownershipScan;
	};
	let periodicScanActive = false;
	const ownershipScanTimer = darwinTracker
		? setInterval(() => {
				if (periodicScanActive) return;
				periodicScanActive = true;
				void scanOwnership()
					.then(ok => {
						if (ok || supervisor.exitCode !== null || supervisor.signalCode !== null) return;
						if (supervisor.pid) {
							try {
								process.kill(-supervisor.pid, "SIGKILL");
							} catch {}
						}
						supervisor.kill("SIGKILL");
					})
					.finally(() => {
						periodicScanActive = false;
					});
			}, 100)
		: undefined;
	const cleanup = (): Promise<void> => {
		cleaning ??= (async () => {
			if (ownershipScanTimer) clearInterval(ownershipScanTimer);
			let trackingOk = await scanOwnership();
			if (supervisor.exitCode === null && supervisor.signalCode === null) {
				if (process.platform !== "win32" && supervisor.pid) {
					try {
						// The directly-owned supervisor is still the live group leader here.
						process.kill(-supervisor.pid, "SIGKILL");
					} catch {}
				}
				supervisor.kill("SIGKILL");
			}
			for (let wave = 0; wave < 3; wave++) {
				await Bun.sleep(wave === 0 ? 5 : 25);
				const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
				const guardian = Process.fromPid(process.pid);
				const pending = guardian?.children() ?? [];
				while (pending.length > 0) {
					const processRef = pending.pop()!;
					retainOwnedProcess(ownedProcesses, processRef);
					pending.push(...processRef.children());
				}
				trackingOk = (await scanOwnership()) && trackingOk;
				for (const owned of ownedProcesses.values()) owned.killTree(9);
			}
			darwinTracker?.close();
			await ledger.close();
			await fs.rm(ownershipFilePath, { force: true });
			if (!trackingOk) throw new Error("Shell ownership tracking failed.");
		})();
		return cleaning;
	};
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		try {
			process.on(signal, () => void cleanup().finally(() => process.exit(1)));
		} catch {}
	}
	const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
		supervisor.once("close", (code, signal) => resolve({ code, signal })),
	);
	await cleanup();
	if (outcome.signal) {
		process.removeAllListeners(outcome.signal);
		process.kill(process.pid, outcome.signal);
	}
	if (outcome.code && outcome.code !== 0) process.exit(outcome.code);
}
