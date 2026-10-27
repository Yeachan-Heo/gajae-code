import type { DesktopFrame, DesktopRequest } from "./protocol";
import { MAX_FRAME_BYTES, parseRequest } from "./protocol";

export interface ProtocolHost {
	handle(request: DesktopRequest): Promise<void>;
	close(): Promise<void>;
}

/** Reads continuously while commands execute; abort and answers never queue behind prompt. */
export async function serveProtocol(
	input: AsyncIterable<Uint8Array>,
	host: ProtocolHost,
	emit: (frame: DesktopFrame) => void,
): Promise<void> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const pending = new Set<Promise<void>>();
	const ids = new Set<string>();
	let buffer = "";
	let closing = false;
	const dispatch = (line: string) => {
		if (!line.trim()) return;
		let request: DesktopRequest;
		try {
			request = parseRequest(line);
		} catch {
			emit({ type: "fatal", error: "Invalid protocol request" });
			return;
		}
		if (ids.has(request.id)) {
			emit({ type: "response", id: request.id, ok: false, error: "Request ID already in flight" });
			return;
		}
		if (
			pending.size >= 128 &&
			request.method !== "abort" &&
			request.method !== "question.answer" &&
			request.method !== "auth.answer" &&
			request.method !== "auth.cancel" &&
			request.method !== "shutdown"
		) {
			emit({ type: "response", id: request.id, ok: false, error: "Too many concurrent requests" });
			return;
		}
		ids.add(request.id);
		if (request.method === "shutdown") closing = true;
		const task = host
			.handle(request)
			.catch(() => emit({ type: "response", id: request.id, ok: false, error: "Host request failed" }))
			.finally(() => {
				ids.delete(request.id);
				pending.delete(task);
			});
		pending.add(task);
	};
	try {
		for await (const chunk of input) {
			buffer += decoder.decode(chunk, { stream: true });
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				dispatch(line);
				if (closing) break;
			}
			if (closing) break;
			if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new Error("Request exceeds frame limit");
		}
		if (!closing) {
			buffer += decoder.decode();
			if (buffer.trim()) dispatch(buffer);
		}
	} finally {
		// Closing first cancels UI waiters and prompts before joining request handlers.
		try {
			await host.close();
		} finally {
			await Promise.allSettled(pending);
		}
	}
}
