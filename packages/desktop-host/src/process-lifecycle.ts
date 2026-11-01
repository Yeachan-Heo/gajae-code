import { usePostmortemSignalExitAuthority } from "@gajae-code/coding-agent/lsp/client";
import { postmortem } from "@gajae-code/utils";

export interface DesktopProcessShutdown {
	close(): Promise<void>;
	/** Join the protocol loop and its final frame flush, not just currently queued frames. */
	flush(): Promise<void>;
	onError(error: unknown): void;
}

/** Process entrypoints only: join host teardown within the shared postmortem deadline. */
export function registerDesktopProcessShutdown(shutdown: DesktopProcessShutdown): () => void {
	usePostmortemSignalExitAuthority();
	return postmortem.register("desktop-host:process", async () => {
		try {
			await shutdown.close();
		} catch (error) {
			shutdown.onError(error);
		} finally {
			process.stdin.destroy();
			try {
				await shutdown.flush();
			} catch (error) {
				shutdown.onError(error);
			}
		}
	});
}
