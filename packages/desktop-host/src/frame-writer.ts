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
	/** Resolve once every queued frame has been handed to the OS. */
	flush(): Promise<void>;
	/** True once a frame could not be delivered; the channel is unusable. */
	readonly failed: boolean;
}

export interface FrameWriterOptions {
	/** Sink for one frame's bytes; resolves once they are accepted. */
	write: (bytes: Uint8Array) => Promise<void>;
	/** Maximum number of bytes waiting behind the sink before the writer gives up. */
	maxBacklogBytes?: number;
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
	let tail: Promise<void> = Promise.resolve();
	let backlog = 0;
	let failed = false;

	return {
		get failed() {
			return failed;
		},
		write(frame: DesktopFrame) {
			if (failed) return;
			let line = JSON.stringify(frame);
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
				line = JSON.stringify({ type: "fatal", error: "Response exceeds frame limit" });
			const bytes = Buffer.from(`${line}\n`);
			if (backlog + bytes.length > maxBacklog) {
				// The parent stopped draining. Dropping frames would desynchronize the
				// protocol, so the channel is declared dead instead.
				failed = true;
				options.onError?.(new Error("Frame backlog exceeded the transport limit"));
				return;
			}
			backlog += bytes.length;
			tail = tail.then(async () => {
				try {
					// Once the channel is dead, later frames are pointless and could only
					// extend a broken stream.
					if (!failed) await options.write(bytes);
				} catch (error) {
					failed = true;
					options.onError?.(error);
				} finally {
					backlog -= bytes.length;
				}
			});
		},
		async flush() {
			await tail;
		},
	};
}
