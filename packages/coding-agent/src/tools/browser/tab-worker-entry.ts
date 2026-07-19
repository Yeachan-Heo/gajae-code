import { parentPort } from "node:worker_threads";
import type { Transport, WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { WorkerCore } from "./tab-worker";

if (!parentPort) throw new Error("tab-worker-entry: missing parentPort");
const port = parentPort;
port.once("message", bootstrap => {
	if (!isBootstrap(bootstrap)) {
		port.postMessage({ type: "bootstrap-failed", error: "Invalid tab worker bootstrap." });
		port.close();
		return;
	}

	const transport: Transport = {
		send(msg, transferList) {
			port.postMessage(msg, transferList ?? []);
		},
		onMessage(handler) {
			const wrap = (message: unknown): void => handler(message as WorkerOutbound | WorkerInbound);
			port.on("message", wrap);
			return () => port.off("message", wrap);
		},
		close() {
			port.close();
		},
	};

	new WorkerCore(transport);
	port.postMessage({ type: "bootstrap-ready", version: 1, mode: "native-free" });
});

function isBootstrap(message: unknown): message is Extract<WorkerInbound, { type: "bootstrap" }> {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === "bootstrap" &&
		(message as { version?: unknown }).version === 1 &&
		(message as { mode?: unknown }).mode === "native-free"
	);
}
