import "./environment";
import * as fs from "node:fs";
import { DesktopHost } from "./host";
import type { DesktopFrame } from "./protocol";
import { MAX_FRAME_BYTES } from "./protocol";
import { serveProtocol } from "./transport";

export async function main(): Promise<void> {
	// Reserve stdout for frames, including when SDK dependencies use console/stdout diagnostics.
	process.stdout.write = process.stderr.write.bind(process.stderr);
	const emit = (frame: DesktopFrame) => {
		let line = JSON.stringify(frame);
		if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
			line = JSON.stringify({ type: "fatal", error: "Response exceeds frame limit" });
		const bytes = Buffer.from(`${line}\n`);
		let offset = 0;
		while (offset < bytes.length) offset += fs.writeSync(1, bytes, offset, bytes.length - offset);
	};
	const host = new DesktopHost({ emit });
	const stop = () => {
		void host
			.close()
			.catch(() => {
				process.exitCode = 1;
			})
			.finally(() => process.stdin.destroy());
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await serveProtocol(process.stdin, host, emit);
	} catch {
		emit({ type: "fatal", error: "Desktop host transport failed" });
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

if (import.meta.main) await main();
