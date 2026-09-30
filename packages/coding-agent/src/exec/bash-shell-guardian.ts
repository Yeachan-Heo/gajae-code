import { dlopen, FFIType, ptr } from "bun:ffi";
import * as childProcess from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as fsSync from "node:fs";
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

export function authenticateOwnershipRecord(
	line: string,
	ledgerToken: string,
): { processRef?: NativeProcess; darwinUniqueId?: bigint; pending?: true } | undefined {
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
	const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
	const owned = Process.fromPid(record.pid);
	const darwinUniqueId = record.darwinUniqueId ? { darwinUniqueId: BigInt(record.darwinUniqueId) } : {};
	if (owned?.incarnation === record.incarnation) return { processRef: owned, ...darwinUniqueId };
	// fromPid() conflates death with an inconclusive lookup. Only a confirmed
	// absence or a different incarnation settles the record; an unknown result
	// keeps it pending so the caller retries the line on the next scan.
	if (!owned && Process.observe(record.pid).status === "unknown") return { pending: true, ...darwinUniqueId };
	return darwinUniqueId;
}

/** Scans an inconclusive ledger record may stay pending before tracking fails closed. */
const MAX_PENDING_LEDGER_ATTEMPTS = 50;

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

export type DarwinAncestryTracker = {
	seed(uniqueId: bigint): void;
	track(processRef: NativeProcess, uniqueId?: bigint): boolean;
	trackGuardian(processRef: NativeProcess, uniqueId?: bigint): boolean;
	poll(): boolean;
	close(): void;
};

export type DarwinIdentity = { uniqueId: bigint; parentUniqueId: bigint };

/** Test seams for the Darwin tracker; production uses libproc and the natives binding. */
export type DarwinAncestryTrackerDeps = {
	uniqueIdentity?: (pid: number) => DarwinIdentity | undefined;
	fromPid?: (pid: number) => NativeProcess | null | undefined;
	observe?: (pid: number) => { status: "present" | "absent" | "unknown"; incarnation?: string };
};

export function createDarwinAncestryTracker(
	owned: Map<string, NativeProcess>,
	deps: DarwinAncestryTrackerDeps = {},
): DarwinAncestryTracker | undefined {
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
		// Ancestry evidence (knownUniqueIds) and successful retention are tracked
		// separately: a descendant whose process validation fails stays known, so its
		// own children still chain, but it is retried on every poll until retained.
		const retainedUniqueIds = new Set<bigint>();
		const { Process } = require("@gajae-code/natives") as NativeProcessBindings;
		const fromPid = deps.fromPid ?? ((pid: number) => Process.fromPid(pid));
		const observe = deps.observe ?? ((pid: number) => Process.observe(pid));
		// Reuse buffer across poll iterations to avoid allocations inside the loop.
		const identityBuffer = new Uint8Array(56);
		const identityView = new DataView(identityBuffer.buffer);
		const defaultUniqueIdentity = (pid: number): { uniqueId: bigint; parentUniqueId: bigint } | undefined => {
			const bytes = proc.symbols.proc_pidinfo(pid, 17, 0, ptr(identityBuffer), identityBuffer.byteLength);
			if (bytes !== identityBuffer.byteLength) return undefined;
			return {
				uniqueId: identityView.getBigUint64(16, true),
				parentUniqueId: identityView.getBigUint64(24, true),
			};
		};
		const uniqueIdentity = deps.uniqueIdentity ?? defaultUniqueIdentity;
		const incarnationOnlyAnchors: NativeProcess[] = [];
		const anchorKeys = new Set<string>();
		const addIncarnationOnlyAnchor = (processRef: NativeProcess): void => {
			const key = `${processRef.pid}:${processRef.incarnation}`;
			if (anchorKeys.has(key)) return;
			anchorKeys.add(key);
			incarnationOnlyAnchors.push(processRef);
		};
		// children() validates its parent and then snapshots the process table; the
		// parent can exit and its pid be reused in between, returning a stranger's
		// children. Only trust a snapshot if the parent still holds its incarnation
		// after it was taken.
		const childrenOf = (parent: NativeProcess): NativeProcess[] => {
			const children = parent.children();
			return fromPid(parent.pid)?.incarnation === parent.incarnation ? children : [];
		};
		const seedAnchorDescendants = (anchor: NativeProcess): void => {
			const pending = [...childrenOf(anchor)];
			while (pending.length > 0) {
				const child = pending.pop()!;
				retainOwnedProcess(owned, child);
				// The unique id is read from a bare pid, so bracket it with incarnation
				// checks against this handle: a pid reused in between would otherwise
				// seed an unrelated process (and its descendants) as owned.
				if (fromPid(child.pid)?.incarnation === child.incarnation) {
					const childId = uniqueIdentity(child.pid)?.uniqueId;
					if (fromPid(child.pid)?.incarnation === child.incarnation) {
						if (childId !== undefined) {
							knownUniqueIds.add(childId);
							retainedUniqueIds.add(childId);
						} else {
							// Its flavor-17 query is denied too: without a unique id the
							// ancestry walk can never reach its subtree, so it must outlive
							// this anchor's pruning as an incarnation-only anchor itself.
							addIncarnationOnlyAnchor(child);
						}
					}
				}
				pending.push(...childrenOf(child));
			}
		};
		const track = (processRef: NativeProcess, signedUniqueId?: bigint): boolean => {
			// The bare-pid unique-id query is only trusted if the same incarnation
			// holds on both sides of it; otherwise a pid reused after the record was
			// authenticated would seed the replacement's ancestry as owned.
			let identity: { uniqueId: bigint; parentUniqueId: bigint } | undefined;
			if (signedUniqueId === undefined) {
				const queried = uniqueIdentity(processRef.pid);
				const after = observe(processRef.pid);
				if (
					after.status === "absent" ||
					(after.status === "present" && after.incarnation !== processRef.incarnation)
				) {
					// Confirmed exited or reused since authentication: retain nothing new.
					return true;
				}
				// Present with the same incarnation keeps the queried id. An
				// inconclusive lookup cannot vouch for it, so the record falls through
				// as incarnation-only and is kept as an anchor rather than dropped.
				identity = after.status === "present" ? queried : undefined;
			}
			const uniqueId = signedUniqueId ?? identity?.uniqueId;
			if (uniqueId === undefined) {
				// Incarnation-only record: the child has no unique id to anchor the
				// ancestry graph. Keep it as an anchor whose live descendants poll()
				// seeds by unique id, so their subtrees stay tracked after the child
				// exits and they reparent (PPID discovery alone would lose them).
				// Residual gap (accepted over #6085's exit 70): if the child forks a
				// descendant that leaves the supervisor process group, then exits before
				// this record is scanned, nothing links that descendant back to us. The
				// ledger watcher scans on append to keep that window minimal.
				retainOwnedProcess(owned, processRef);
				addIncarnationOnlyAnchor(processRef);
				seedAnchorDescendants(processRef);
				return true;
			}
			knownUniqueIds.add(uniqueId);
			retainedUniqueIds.add(uniqueId);
			retainOwnedProcess(owned, processRef);
			return true;
		};
		const trackGuardian = (processRef: NativeProcess, signedUniqueId?: bigint): boolean => {
			const identity = signedUniqueId === undefined ? uniqueIdentity(processRef.pid) : undefined;
			const uniqueId = signedUniqueId ?? identity?.uniqueId;
			// Guardian registration is strict: must have a unique id
			if (uniqueId === undefined) return false;
			knownUniqueIds.add(uniqueId);
			retainedUniqueIds.add(uniqueId);
			retainOwnedProcess(owned, processRef);
			return true;
		};
		return {
			seed(uniqueId) {
				knownUniqueIds.add(uniqueId);
			},
			track,
			trackGuardian,
			poll() {
				// Re-seed live anchors, then drop exited ones: their descendants were
				// seeded by unique id while the anchor was alive, and ancestry now
				// carries them, so re-walking a dead anchor only costs time.
				for (let index = incarnationOnlyAnchors.length - 1; index >= 0; index--) {
					const anchor = incarnationOnlyAnchors[index]!;
					seedAnchorDescendants(anchor);
					if (fromPid(anchor.pid)?.incarnation !== anchor.incarnation) {
						incarnationOnlyAnchors.splice(index, 1);
						anchorKeys.delete(`${anchor.pid}:${anchor.incarnation}`);
					}
				}
				const capacity = proc.symbols.proc_listallpids(null, 0);
				if (capacity <= 0) return false;
				const pids = new Int32Array(capacity + 64);
				const count = proc.symbols.proc_listallpids(ptr(pids), pids.byteLength);
				if (count <= 0) return false;
				// First pass: collect identities for all pids, avoiding Process.fromPid calls.
				const identities = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>();
				for (let index = 0; index < count; index++) {
					const pid = pids[index]!;
					const identity = uniqueIdentity(pid);
					if (identity) identities.set(pid, identity);
				}
				// Extend ancestry evidence, then validate every listed pid that is known but
				// not yet retained: new descendants plus earlier ones whose Process.fromPid
				// check failed (it can return null for a live pid it could not query). A pid
				// whose identity changed between the listing and the check was reused; skip it.
				extendOwnedDarwinAncestry(knownUniqueIds, identities);
				for (const [pid, listed] of identities) {
					if (!knownUniqueIds.has(listed.uniqueId) || retainedUniqueIds.has(listed.uniqueId)) continue;
					const before = fromPid(pid);
					if (!before) continue;
					const identity = uniqueIdentity(pid);
					const after = fromPid(pid);
					if (identity?.uniqueId === listed.uniqueId && after?.incarnation === before.incarnation) {
						retainOwnedProcess(owned, after);
						retainedUniqueIds.add(listed.uniqueId);
					}
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
		if (!guardian || !darwinTracker.trackGuardian(guardian)) {
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
	let pendingLedgerLines: string[] = [];
	const pendingAttempts = new Map<string, number>();
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
			const fresh = ledgerBuffer.split("\n");
			ledgerBuffer = fresh.pop() ?? "";
			const lines = [...pendingLedgerLines, ...fresh];
			pendingLedgerLines = [];
			for (const line of lines) {
				if (!line) continue;
				const owned = authenticateOwnershipRecord(line, ledgerToken);
				if (owned?.pending) {
					// Inconclusive lookup: retry next scan, bounded so a pid stuck in an
					// unknown state cannot grow the queue or starve cleanup forever.
					const attempts = (pendingAttempts.get(line) ?? 0) + 1;
					if (attempts > MAX_PENDING_LEDGER_ATTEMPTS) return false;
					pendingAttempts.set(line, attempts);
					pendingLedgerLines.push(line);
				} else {
					pendingAttempts.delete(line);
				}
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
	let periodicScanRequested = false;
	const runPeriodicScan = (): void => {
		if (periodicScanActive) {
			periodicScanRequested = true;
			return;
		}
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
				if (periodicScanRequested && !cleaning) {
					periodicScanRequested = false;
					runPeriodicScan();
				}
			});
	};
	const ownershipScanTimer = darwinTracker ? setInterval(runPeriodicScan, 100) : undefined;
	// Scan as soon as the supervisor appends a ledger record instead of waiting
	// for the next tick. An incarnation-only record's descendants are only
	// reachable while that child is alive, so the anchor must be taken promptly.
	let ledgerWatcher: fsSync.FSWatcher | undefined;
	if (darwinTracker) {
		try {
			ledgerWatcher = fsSync.watch(ownershipFilePath, runPeriodicScan);
			ledgerWatcher.on("error", () => {});
		} catch {
			ledgerWatcher = undefined;
		}
	}
	const cleanup = (): Promise<void> => {
		cleaning ??= (async () => {
			if (ownershipScanTimer) clearInterval(ownershipScanTimer);
			ledgerWatcher?.close();
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
