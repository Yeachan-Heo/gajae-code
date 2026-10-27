import { type MessagePort, parentPort } from "node:worker_threads";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "./worker-protocol";

if (!parentPort) throw new Error("js worker-entry: missing parentPort");

const parent = parentPort;

function isHostPort(value: unknown): value is MessagePort {
	if (!value || typeof value !== "object") return false;
	const port = value as MessagePort;
	return typeof port.postMessage === "function" && typeof port.on === "function";
}

function readBindPort(data: unknown): MessagePort | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as { type?: unknown; port?: unknown };
	if (record.type !== "gjc-bind" || !isHostPort(record.port)) return undefined;
	return record.port;
}

function listen(port: MessagePort): void {
	// Bound before any user cell. A later prototype patch cannot retarget this send.
	const post = port.postMessage.bind(port);
	const transport: Transport = {
		send: (msg: WorkerOutbound) => {
			post(msg);
		},
		onMessage: handler => {
			const wrap = (data: unknown): void => handler(data as WorkerInbound);
			parent.on("message", wrap);
			return () => parent.off("message", wrap);
		},
		close: () => {
			try {
				port.close();
			} catch {
				// Already closed.
			}
			try {
				parent.close();
			} catch {
				// Already closed.
			}
		},
	};
	new WorkerCore(transport);
}

const onParent = (data: unknown): void => {
	const port = readBindPort(data);
	if (!port) return;
	if (data && typeof data === "object") (data as { port?: unknown }).port = undefined;
	parent.off("message", onParent);
	listen(port);
};
parent.on("message", onParent);
