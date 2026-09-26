import { isBunTestRuntime } from "@gajae-code/utils";

type NativeTtyWriter = InstanceType<typeof import("@gajae-code/natives").TtyWriter>;
type NativeBindings = Pick<typeof import("@gajae-code/natives"), "TtyWriter">;

let nativeWriter: NativeTtyWriter | undefined;

function stopNativeWriterOnExit(): void {
	const writer = nativeWriter;
	if (!writer) return;
	nativeWriter = undefined;
	try {
		writer.stop(250);
	} catch {
		// Process exit is best-effort; a vanished PTY must not block shutdown.
	}
}

function getNativeWriter(): NativeTtyWriter {
	if (!nativeWriter) {
		// Keep the native addon out of the module graph until terminal output is
		// first needed. This is the synchronous lazy-load contract for W5b.
		const { TtyWriter } = require("@gajae-code/natives") as NativeBindings;
		nativeWriter = new TtyWriter(1);
		process.once("exit", stopNativeWriterOnExit);
	}
	return nativeWriter;
}

/**
 * Write terminal bytes in FIFO order. Windows intentionally retains Bun's
 * ConPTY-aware stdout writer; Unix uses the lazily-created native pump. Bun's
 * unit-test runtime keeps stdout writes observable to the existing spies.
 */
export function writeTerminalOutput(data: string): void {
	if (process.platform === "win32" || isBunTestRuntime()) {
		process.stdout.write(data);
		return;
	}
	getNativeWriter().write(data);
}

/** True once the Unix pump has detected a closed or unusable terminal fd. */
export function terminalWriterIsDead(): boolean {
	return process.platform !== "win32" && !isBunTestRuntime() && Boolean(nativeWriter?.dead);
}

/** Flush queued terminal output at teardown without waiting indefinitely. */
export function flushTerminalOutput(timeoutMs = 250): boolean {
	if (process.platform === "win32" || isBunTestRuntime() || !nativeWriter) return true;
	return nativeWriter.flushSync(timeoutMs);
}
