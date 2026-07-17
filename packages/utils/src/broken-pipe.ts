/**
 * Broken-pipe classification for writers that own a local output sink and for
 * the process-wide postmortem fallback.
 *
 * A local writer may classify its own sink closure from the error code. The
 * process-wide fallback is deliberately stricter: an `EPIPE` must be
 * attributable to process stdout before it receives SIGPIPE-style shutdown.
 */
import * as fs from "node:fs";

const KNOWN_SINK_PEER_CLOSED_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

type ErrorProperty = "code" | "fd" | "syscall";

interface ErrorPropertyRead {
	available: boolean;
	value: unknown;
}

function isObjectLike(value: unknown): value is object {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function readErrorProperty(error: object, property: ErrorProperty): ErrorPropertyRead {
	try {
		return { available: true, value: Reflect.get(error, property) };
	} catch {
		return { available: false, value: undefined };
	}
}

function isUsableFileDescriptor(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
interface FileIdentity {
	dev: number | bigint;
	ino: number | bigint;
}

function fileIdentity(fd: number): FileIdentity | undefined {
	try {
		const stat = fs.fstatSync(fd);
		return { dev: stat.dev, ino: stat.ino };
	} catch {
		return undefined;
	}
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/**
 * True when an error from a writer that owns its sink reports that the peer
 * closed that sink. This intentionally accepts structural error objects rather
 * than requiring an `Error` instance.
 */
export function isKnownSinkPeerClosedError(error: unknown): boolean {
	if (!isObjectLike(error)) return false;
	const code = readErrorProperty(error, "code");
	return code.available && typeof code.value === "string" && KNOWN_SINK_PEER_CLOSED_CODES.has(code.value);
}

/**
 * Backward-compatible local-sink classifier for output writers. Callers must
 * use it only when they own the sink that produced the error.
 */
export function isBrokenPipeError(error: unknown): boolean {
	return isKnownSinkPeerClosedError(error);
}

/**
 * A classifier for process-level stdout `EPIPE` errors. Its direct-write
 * evidence is private to each factory instance, so only the owner that
 * intercepted `process.stdout.write` can mark an error for this classifier.
 */
export interface ProcessStdoutEpipeClassifier {
	markDirectProcessStdoutWriteError(error: unknown): void;
	isAttributableProcessStdoutEpipe(error: unknown): boolean;
}

export function createProcessStdoutEpipeClassifier(): ProcessStdoutEpipeClassifier {
	const directProcessStdoutWriteErrors = new WeakSet<object>();
	const initialStdoutIdentity = isUsableFileDescriptor(process.stdout.fd)
		? fileIdentity(process.stdout.fd)
		: undefined;

	const hasCurrentStdoutIdentity = (fd: number): boolean => {
		if (!initialStdoutIdentity) return false;
		let stdoutFd: number;
		try {
			stdoutFd = process.stdout.fd;
		} catch {
			return false;
		}
		if (!isUsableFileDescriptor(stdoutFd)) return false;
		const currentStdoutIdentity = fileIdentity(stdoutFd);
		const errorFdIdentity = fileIdentity(fd);
		if (!currentStdoutIdentity || !errorFdIdentity) return false;
		if (!sameFileIdentity(currentStdoutIdentity, initialStdoutIdentity)) return false;
		return fd === stdoutFd || sameFileIdentity(errorFdIdentity, currentStdoutIdentity);
	};

	return {
		markDirectProcessStdoutWriteError(error: unknown): void {
			if (isObjectLike(error)) directProcessStdoutWriteErrors.add(error);
		},
		isAttributableProcessStdoutEpipe(error: unknown): boolean {
			if (!isObjectLike(error)) return false;

			const code = readErrorProperty(error, "code");
			if (!code.available || code.value !== "EPIPE") return false;

			if (directProcessStdoutWriteErrors.has(error)) return true;

			const syscall = readErrorProperty(error, "syscall");
			if (!syscall.available || syscall.value !== "write") return false;

			const fd = readErrorProperty(error, "fd");
			if (!fd.available || !isUsableFileDescriptor(fd.value)) return false;

			return hasCurrentStdoutIdentity(fd.value);
		},
	};
}

/**
 * Exit code for a producer terminated because its output pipe broke:
 * 128 + SIGPIPE (13), matching what shells report for SIGPIPE-killed tools
 * in `foo | head`-style pipelines.
 */
export const BROKEN_PIPE_EXIT_CODE = 141;
