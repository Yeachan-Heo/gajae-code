import "./environment";
import { createFrameWriter } from "./frame-writer";
import { DesktopHost } from "./host";
import type { DesktopFrame, DesktopRequest } from "./protocol";
import { serveProtocol } from "./transport";

export async function main(): Promise<void> {
	// Reserve stdout for frames, including when SDK dependencies use console/stdout diagnostics.
	process.stdout.write = process.stderr.write.bind(process.stderr);
	// stdout is a non-blocking pipe owned by the desktop app: write frames
	// asynchronously so a frame larger than the pipe buffer is never truncated.
	const frames = createFrameWriter({
		write: async bytes => {
			await Bun.write(Bun.stdout, bytes);
		},
		onError: error => {
			// The frame channel is gone; report it and stop pretending to serve.
			process.stderr.write(`desktop host frame channel failed: ${String(error)}\n`);
			process.exitCode = 1;
		},
	});
	const emit = (frame: DesktopFrame) => frames.write(frame);
	const host = new DesktopHost({ emit });
	// Opt-in request trace for diagnosing a desktop connection. Method names only:
	// parameters can carry user text or credentials.
	const traced =
		process.env.GJC_DESKTOP_TRACE === "1"
			? {
					async handle(request: DesktopRequest) {
						process.stderr.write(`desktop host request: ${request.method}\n`);
						await host.handle(request);
					},
					close: () => host.close(),
				}
			: host;
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
		await serveProtocol(process.stdin, traced, emit);
	} catch {
		emit({ type: "fatal", error: "Desktop host transport failed" });
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		// Frames queued behind a slow parent must reach it before exit.
		await frames.flush();
	}
}

if (import.meta.main) await main();
