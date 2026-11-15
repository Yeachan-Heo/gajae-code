import type * as stream from "node:stream";
import type { DesktopFrame } from "./protocol";
import { MAX_FRAME_BYTES } from "./protocol";

/**
 * Frame writer for the host's stdout channel.
 *
 * The desktop app runs the host with a non-blocking stdout pipe, so a frame
 * larger than the pipe buffer (64 KiB on macOS) cannot be written with a single
 * synchronous `writeSync` call: it either throws `EAGAIN` or would need a busy
 * wait, and either way a partially written frame corrupts the stream and the
 * parent reports invalid JSON at the pipe boundary. Frames are therefore queued
 * and written asynchronously, one at a time, so a partial write can never be
 * interleaved with the next frame.
 */
export interface FrameWriter {
	/** Queue one frame. Never splits a frame, never interleaves two frames. */
	write(frame: DesktopFrame): void;
	/**
	 * Wait for queued writes, or stop waiting once the channel has failed.
	 * No delivery is promised after failure.
	 */
	flush(): Promise<void>;
	/** True once a frame could not be delivered; the channel is unusable. */
	readonly failed: boolean;
}

export interface FrameWriterOptions {
	/** Sink for one frame's bytes; resolves once they are accepted. */
	write: (bytes: Uint8Array) => Promise<void>;
	/** Maximum number of bytes waiting behind the sink before the writer gives up. */
	maxBacklogBytes?: number;
	/** Called once on terminal failure; a thrown observer error is surfaced by flush. */
	onError?: (error: unknown) => void;
}

export function createWritableFrameSink(writable: stream.Writable): (bytes: Uint8Array) => Promise<void> {
	const write = writable.write.bind(writable);
	return bytes => {
		const result = Promise.withResolvers<void>();
		const onError = (error: Error) => result.reject(error);
		writable.once("error", onError);
		try {
			write(bytes, error => {
				if (error) {
					// Node can call back before emitting the corresponding error event.
					result.reject(error);
				} else {
					writable.removeListener("error", onError);
					result.resolve();
				}
			});
		} catch (error) {
			writable.removeListener("error", onError);
			result.reject(error);
		}
		return result.promise;
	};
}

const DEFAULT_BACKLOG_BYTES = 64 * 1024 * 1024;

export function createFrameWriter(options: FrameWriterOptions): FrameWriter {
	const maxBacklog = options.maxBacklogBytes ?? DEFAULT_BACKLOG_BYTES;
	const failure = Promise.withResolvers<void>();
	let tail: Promise<void> = Promise.resolve();
	let backlog = 0;
	let failed = false;
	let sinkFailed = false;
	let notificationFailed = false;
	let notificationError: unknown;

	function fail(error: unknown): void {
		if (failed) return;
		failed = true;
		// An active sink may never settle. Retire admission and release flush
		// independently, while keeping the tail attached to observe late errors.
		failure.resolve();
		try {
			options.onError?.(error);
		} catch (error) {
			// Surface observer failures through flush, not an unhandled queue tail.
			notificationFailed = true;
			notificationError = error;
		}
	}

	function enqueue(bytes: Uint8Array, terminal = false): void {
		backlog += bytes.length;
		tail = tail.then(async () => {
			try {
				// Only a best-effort terminal fatal may follow failure, and never
				// after the sink itself has rejected a write.
				if (!failed || (terminal && !sinkFailed)) await options.write(bytes);
			} catch (error) {
				sinkFailed = true;
				fail(error);
			} finally {
				backlog -= bytes.length;
			}
		});
	}

	return {
		get failed() {
			return failed;
		},
		write(frame: DesktopFrame) {
			if (failed) return;
			let line: string;
			try {
				line = JSON.stringify(frame);
			} catch (error) {
				fail(error);
				return;
			}
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
				const error = "Response exceeds frame limit";
				const fatal = Buffer.from(`${JSON.stringify({ type: "fatal", error })}\n`);
				if (backlog + fatal.length <= maxBacklog) enqueue(fatal, true);
				fail(new Error(error));
				return;
			}
			const bytes = Buffer.from(`${line}\n`);
			if (backlog + bytes.length > maxBacklog) {
				// Dropping frames would desynchronize the protocol. Do not wait for
				// a parent that has stopped draining before allowing host teardown.
				fail(new Error("Frame backlog exceeded the transport limit"));
				return;
			}
			enqueue(bytes);
		},
		async flush() {
			await Promise.race([tail, failure.promise]);
			if (notificationFailed) throw notificationError;
		},
	};
}
