export const MCP_MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export const MCP_MAX_ERROR_BYTES = 16 * 1024;
export const MCP_MAX_SSE_REQUEST_MESSAGES = 1024;
export const MCP_MAX_SSE_BATCH_MESSAGES = 1024;
export const MCP_HTTP_TIMEOUT_MS = 30_000;

function ignoreCancellation(cancel: () => Promise<unknown>): void {
	try {
		void cancel().catch(() => {});
	} catch {}
}

export function cancelMCPStream(stream: ReadableStream<Uint8Array> | null): void {
	if (stream) ignoreCancellation(() => stream.cancel());
}

type ByteReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read">;

async function readChunk(reader: ByteReader, signal?: AbortSignal) {
	if (!signal) return reader.read();
	signal.throwIfAborted();
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([reader.read(), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export async function readMCPResponseText(response: Response, limit: number, truncate = false, signal?: AbortSignal) {
	const declared = response.headers.get("Content-Length");
	if (!truncate && declared && /^\d+$/.test(declared) && Number(declared) > limit) {
		cancelMCPStream(response.body);
		throw new Error("MCP response exceeds size limit");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	let buffer = new Uint8Array(Math.min(limit, 64 * 1024));
	let total = 0;
	try {
		while (true) {
			const { value, done } = await readChunk(reader, signal);
			if (done) break;
			if (value.length === 0) continue;
			const remaining = limit - total;
			if (value.length > remaining) {
				if (truncate && remaining > 0) buffer.set(value.subarray(0, remaining), total);
				ignoreCancellation(() => reader.cancel());
				if (!truncate) throw new Error("MCP response exceeds size limit");
				return `${new TextDecoder().decode(buffer)}\u2026`;
			}
			if (total + value.length > buffer.length) {
				const grown = new Uint8Array(Math.min(limit, Math.max(total + value.length, buffer.length * 2)));
				grown.set(buffer);
				buffer = grown;
			}
			buffer.set(value, total);
			total += value.length;
		}
		return new TextDecoder().decode(buffer.subarray(0, total));
	} catch (error) {
		ignoreCancellation(() => reader.cancel());
		throw error;
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
}
