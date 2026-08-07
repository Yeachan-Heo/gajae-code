import { parentPort } from "node:worker_threads";
import type { NativeExactFileIdentity, NativeExactUnlinkResult, NativeNoReplaceResult } from "@gajae-code/natives";
import { exactReplacePath, linkNoReplacePath, renameNoReplacePath } from "@gajae-code/natives";

export type AtomicYamlNativeWorkerRequest =
	| {
			operation: "exact-replace";
			sourcePath: string;
			destinationPath: string;
			expectedSource: NativeExactFileIdentity;
			expectedDestination: NativeExactFileIdentity;
	  }
	| {
			operation: "no-replace";
			sourcePath: string;
			destinationPath: string;
	  }
	| {
			operation: "no-replace-link";
			sourcePath: string;
			destinationPath: string;
	  };

export type AtomicYamlNativeWorkerResponse =
	| { type: "result"; result: NativeExactUnlinkResult | NativeNoReplaceResult }
	| { type: "error"; name?: string; message: string; stack?: string };

if (!parentPort) throw new Error("atomic YAML native worker: missing parentPort");

const port = parentPort;
port.once("message", (request: AtomicYamlNativeWorkerRequest) => {
	try {
		const result =
			request.operation === "exact-replace"
				? exactReplacePath(
						request.sourcePath,
						request.destinationPath,
						request.expectedSource,
						request.expectedDestination,
					)
				: request.operation === "no-replace-link"
					? linkNoReplacePath(request.sourcePath, request.destinationPath)
					: renameNoReplacePath(request.sourcePath, request.destinationPath);
		port.postMessage({ type: "result", result } satisfies AtomicYamlNativeWorkerResponse);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		port.postMessage({
			type: "error",
			name: failure.name,
			message: failure.message,
			stack: failure.stack,
		} satisfies AtomicYamlNativeWorkerResponse);
	} finally {
		port.close();
	}
});
