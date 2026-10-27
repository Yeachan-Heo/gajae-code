import * as crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as syncFs from "node:fs";
import * as path from "node:path";
import * as nodeWorkerThreads from "node:worker_threads";
import type { NativeExactFileIdentity, NativeExactUnlinkResult, NativeNoReplaceResult } from "@gajae-code/natives";
import { exactReplacePath, exactUnlinkDirect, renameNoReplacePath } from "@gajae-code/natives";
import { brokerExitRecordGeneration } from "./broker-exit";

export type BrokerExitWriterTestBarrier = {
	phase: "before-commit" | "after-commit";
	entered: SharedArrayBuffer;
	release: SharedArrayBuffer;
	finished: SharedArrayBuffer;
};

export type BrokerExitWriterWorkerRequest = {
	destinationPath: string;
	temporaryPath: string;
	generation: number;
	cancellation: SharedArrayBuffer;
	testBarrier?: BrokerExitWriterTestBarrier;
};

export type BrokerExitWriterWorkerResponse =
	| { type: "publication-ready" }
	| { type: "result"; result: "written" | "superseded" | "cancelled" }
	| { type: "error"; name?: string; message: string; stack?: string };

type BrokerExitWriterDecision = { type: "decision"; decision: "accept" | "cancel" };

interface FileSnapshot {
	identity: NativeExactFileIdentity;
	contents?: string;
}

interface RecordGeneration {
	writtenAt: number;
	mtimeNs: bigint;
}

const MAX_BROKER_EXIT_RECORD_BYTES = 1_024;
const MAX_PUBLICATION_ATTEMPTS = 8;

function sameStats(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

function snapshotFile(filePath: string, quarantineName: string): FileSnapshot | undefined {
	let namedBefore: BigIntStats;
	try {
		namedBefore = syncFs.lstatSync(filePath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!namedBefore.isFile()) throw new Error("SDK broker exit record path is not a regular file.");
	const descriptor = syncFs.openSync(filePath, "r");
	try {
		const before = syncFs.fstatSync(descriptor, { bigint: true });
		if (!before.isFile() || !sameStats(namedBefore, before))
			throw new Error("SDK broker exit record changed while its identity was captured.");
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
			throw new Error("SDK broker exit record file is too large to identify safely.");
		const parent = syncFs.statSync(path.dirname(filePath), { bigint: true });
		if (!parent.isDirectory()) throw new Error("SDK broker exit record parent is not a directory.");
		const fileSize = Number(before.size);
		const contents = fileSize <= MAX_BROKER_EXIT_RECORD_BYTES ? Buffer.alloc(fileSize) : undefined;
		const hash = crypto.createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let offset = 0;
		while (offset < fileSize) {
			const length = syncFs.readSync(descriptor, chunk, 0, Math.min(chunk.length, fileSize - offset), offset);
			if (length === 0) throw new Error("SDK broker exit record changed while its contents were read.");
			hash.update(chunk.subarray(0, length));
			contents?.set(chunk.subarray(0, length), offset);
			offset += length;
		}
		const after = syncFs.fstatSync(descriptor, { bigint: true });
		const namedAfter = syncFs.lstatSync(filePath, { bigint: true });
		if (!sameStats(before, after) || !sameStats(after, namedAfter))
			throw new Error("SDK broker exit record changed while its identity was captured.");
		return {
			identity: {
				dev: before.dev,
				ino: before.ino,
				nlink: before.nlink,
				parentDev: parent.dev,
				parentIno: parent.ino,
				size: before.size,
				mtimeNs: before.mtimeNs,
				sha256: hash.digest("hex"),
				quarantineName,
			},
			...(contents === undefined ? {} : { contents: contents.toString("utf8") }),
		};
	} finally {
		syncFs.closeSync(descriptor);
	}
}

function recordGeneration(contents: string | undefined, mtimeNs: bigint | undefined): RecordGeneration | undefined {
	if (contents === undefined) return undefined;
	try {
		const writtenAt = brokerExitRecordGeneration(JSON.parse(contents));
		return writtenAt === undefined || mtimeNs === undefined ? undefined : { writtenAt, mtimeNs };
	} catch {
		return undefined;
	}
}

function generationIsAtLeastAsNew(
	current: RecordGeneration,
	incomingWrittenAt: number,
	incomingMtimeNs: bigint,
): boolean {
	if (current.writtenAt !== incomingWrittenAt) return current.writtenAt > incomingWrittenAt;
	return current.mtimeNs >= incomingMtimeNs;
}

function sameFile(left: NativeExactFileIdentity | undefined, right: NativeExactFileIdentity): boolean {
	return (
		left !== undefined &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.parentDev === right.parentDev &&
		left.parentIno === right.parentIno &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

function sameSnapshot(left: FileSnapshot | undefined, right: FileSnapshot | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return sameFile(left.identity, right.identity);
}

function cancellationRequested(cancellation: Int32Array): boolean {
	return Atomics.load(cancellation, 0) !== 0;
}

function pauseAtTestBarrier(
	barrier: BrokerExitWriterTestBarrier | undefined,
	phase: BrokerExitWriterTestBarrier["phase"],
): void {
	if (!barrier || barrier.phase !== phase) return;
	const entered = new Int32Array(barrier.entered);
	const release = new Int32Array(barrier.release);
	Atomics.store(entered, 0, 1);
	Atomics.notify(entered, 0);
	while (Atomics.load(release, 0) === 0) Atomics.wait(release, 0, 0);
}

function exactCleanup(filePath: string, identity: NativeExactFileIdentity): void {
	const result = exactUnlinkDirect(filePath, identity);
	if (
		!result.ok &&
		result.code !== "identity_mismatch" &&
		result.code !== "not_found" &&
		result.code !== "file_not_found" &&
		result.code !== "path_not_found"
	)
		throw new Error(`SDK broker exit record exact cleanup failed: ${result.code ?? "unknown"}.`);
}

function waitForParentDecision(port: nodeWorkerThreads.MessagePort): Promise<BrokerExitWriterDecision["decision"]> {
	return new Promise(resolve => {
		port.once("message", (message: BrokerExitWriterDecision) => {
			resolve(message?.type === "decision" && message.decision === "accept" ? "accept" : "cancel");
		});
		port.postMessage({ type: "publication-ready" } satisfies BrokerExitWriterWorkerResponse);
	});
}

async function finishPublication(
	port: nodeWorkerThreads.MessagePort,
	request: BrokerExitWriterWorkerRequest,
	cancellation: Int32Array,
	sourceIdentity: NativeExactFileIdentity,
): Promise<"written" | "cancelled"> {
	pauseAtTestBarrier(request.testBarrier, "after-commit");
	if (cancellationRequested(cancellation)) {
		exactCleanup(request.destinationPath, sourceIdentity);
		return "cancelled";
	}
	const decision = await waitForParentDecision(port);
	if (decision !== "accept" || cancellationRequested(cancellation)) {
		exactCleanup(request.destinationPath, sourceIdentity);
		return "cancelled";
	}
	return "written";
}

async function publishRecord(
	port: nodeWorkerThreads.MessagePort,
	request: BrokerExitWriterWorkerRequest,
): Promise<"written" | "superseded" | "cancelled"> {
	const cancellation = new Int32Array(request.cancellation);
	const sourceQuarantineName = `${path.basename(request.temporaryPath)}.cleanup`;
	const source = snapshotFile(request.temporaryPath, sourceQuarantineName);
	if (!source) throw new Error("SDK broker exit record staging file is missing.");
	const sourceIdentity = source.identity;
	const sourceGeneration = recordGeneration(source.contents, sourceIdentity.mtimeNs);
	if (!sourceGeneration || sourceGeneration.writtenAt !== request.generation) {
		exactCleanup(request.temporaryPath, sourceIdentity);
		throw new Error("SDK broker exit record staging payload does not match its generation.");
	}
	let beforeCommitBarrierUsed = false;
	try {
		for (let attempt = 0; attempt < MAX_PUBLICATION_ATTEMPTS; attempt++) {
			if (cancellationRequested(cancellation)) {
				exactCleanup(request.temporaryPath, sourceIdentity);
				return "cancelled";
			}
			const currentSource = snapshotFile(request.temporaryPath, sourceQuarantineName);
			if (!currentSource || !sameFile(currentSource.identity, sourceIdentity))
				throw new Error("SDK broker exit record staging identity changed before publication.");
			const destinationQuarantineName = `${path.basename(request.temporaryPath)}.${attempt}.${crypto.randomUUID()}.retired`;
			const destination = snapshotFile(request.destinationPath, destinationQuarantineName);
			const destinationGeneration = recordGeneration(destination?.contents, destination?.identity.mtimeNs);
			if (
				destinationGeneration !== undefined &&
				generationIsAtLeastAsNew(destinationGeneration, request.generation, sourceIdentity.mtimeNs)
			) {
				exactCleanup(request.temporaryPath, sourceIdentity);
				return "superseded";
			}
			if (!beforeCommitBarrierUsed) {
				beforeCommitBarrierUsed = true;
				pauseAtTestBarrier(request.testBarrier, "before-commit");
			}
			if (cancellationRequested(cancellation)) {
				exactCleanup(request.temporaryPath, sourceIdentity);
				return "cancelled";
			}

			let result: NativeExactUnlinkResult | NativeNoReplaceResult;
			try {
				result = destination
					? exactReplacePath(request.temporaryPath, request.destinationPath, sourceIdentity, destination.identity)
					: renameNoReplacePath(request.temporaryPath, request.destinationPath);
			} catch (error) {
				const currentDestination = snapshotFile(request.destinationPath, destinationQuarantineName);
				if (sameFile(currentDestination?.identity, sourceIdentity))
					return await finishPublication(port, request, cancellation, sourceIdentity);
				throw error;
			}
			let published = result.ok;
			let currentDestination: FileSnapshot | undefined;
			if (!published) {
				currentDestination = snapshotFile(request.destinationPath, destinationQuarantineName);
				published = sameFile(currentDestination?.identity, sourceIdentity);
			}
			if (published) return await finishPublication(port, request, cancellation, sourceIdentity);
			const reason = "reason" in result ? result.reason : undefined;
			const destinationExists = result.code === "destination_exists" || reason === "destination_exists";
			if (destinationExists || result.code === "identity_mismatch") continue;
			if (!sameSnapshot(currentDestination, destination)) continue;
			throw new Error(`SDK broker exit record atomic publication failed: ${result.code ?? reason ?? "unknown"}.`);
		}
		exactCleanup(request.temporaryPath, sourceIdentity);
		throw new Error("SDK broker exit record publication conflicted repeatedly.");
	} catch (error) {
		// A completed exchange moves the staged identity to the destination. The
		// exact cleanup below can only remove the original private staging name.
		try {
			exactCleanup(request.temporaryPath, sourceIdentity);
		} catch {
			// Preserve the publication error; exact identity fencing still prevents
			// cleanup from unlinking a substituted source or accepted destination.
		}
		throw error;
	}
}

const { parentPort } = nodeWorkerThreads;
if (!parentPort) throw new Error("SDK broker exit writer worker: missing parentPort");

const port = parentPort;
port.once("message", (request: BrokerExitWriterWorkerRequest) => {
	void (async () => {
		try {
			const result = await publishRecord(port, request);
			port.postMessage({ type: "result", result } satisfies BrokerExitWriterWorkerResponse);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			port.postMessage({
				type: "error",
				name: failure.name,
				message: failure.message,
				stack: failure.stack,
			} satisfies BrokerExitWriterWorkerResponse);
		} finally {
			if (request?.testBarrier) {
				const finished = new Int32Array(request.testBarrier.finished);
				Atomics.store(finished, 0, 1);
				Atomics.notify(finished, 0);
			}
			port.close();
		}
	})();
});
