// Drain continuously so the child cannot block on stderr, retaining only the
// diagnostic tail. A descendant may inherit the pipe after the child exits.
export function childDiagnostics(stderr: ReadableStream<Uint8Array>, secrets: string[] = []) {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let tail = "";
	let flushed = false;
	const append = (text: string) => {
		tail = (tail + text).slice(-4000);
	};
	const flush = () => {
		if (flushed) return;
		flushed = true;
		append(decoder.decode());
	};
	const drain = (async () => {
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done || flushed) break;
				append(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Preserve the diagnostics already received if the pipe fails.
		} finally {
			flush();
			reader.releaseLock();
		}
	})();

	let result: Promise<string> | undefined;
	return {
		wait(timeoutMs: number): Promise<string> {
			result ??= (async () => {
				const timeout = Promise.withResolvers<boolean>();
				const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
				try {
					const finished = await Promise.race([drain.then(() => true), timeout.promise]);
					if (!finished) {
						void reader.cancel().catch(() => {});
						// Cancellation may itself never settle. Flush synchronously, then
						// give the pending read a bounded opportunity to finish.
						flush();
						const cancelled = Promise.withResolvers<void>();
						const cancelTimer = setTimeout(() => cancelled.resolve(), 100);
						try {
							await Promise.race([drain, cancelled.promise]);
						} finally {
							clearTimeout(cancelTimer);
						}
					}
					return secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, "[REDACTED]") : text), tail);
				} finally {
					clearTimeout(timer);
				}
			})();
			return result;
		},
	};
}
