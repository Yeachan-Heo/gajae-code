import { parentPort } from "node:worker_threads";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import { exactRemoveDirectoryTreeOp, snapshotDirectoryTreeOp } from "./exact-identity-tree-ops";

/**
 * Worker body for the async identity-tree doubles in `exact-identity-natives.ts`.
 *
 * The production addon runs `snapshot_directory_tree` and
 * `exact_remove_directory_tree` on dedicated native threads; this worker runs the
 * same walk so the async doubles are genuinely nonblocking from the main thread,
 * and a wedged walk cannot stall the test event loop.
 */
const port = parentPort;
if (!port) throw new Error("exact-identity-tree-worker must run as a Worker");

interface ExactDirectoryTreeWorkerRequest {
	id: number;
	op: "snapshot" | "remove";
	root: string;
	snapshot?: NativeDirectoryTreeSnapshot;
}

port.on("message", (request: ExactDirectoryTreeWorkerRequest) => {
	try {
		switch (request.op) {
			case "snapshot":
				port.postMessage({ id: request.id, result: snapshotDirectoryTreeOp(request.root) });
				return;
			case "remove":
				if (!request.snapshot) throw new Error("removal requires the authorized snapshot");
				port.postMessage({
					id: request.id,
					result: exactRemoveDirectoryTreeOp(request.root, request.snapshot),
				});
		}
	} catch {
		port.postMessage({ id: request.id, result: { ok: false, code: "io_error" } });
	}
});
