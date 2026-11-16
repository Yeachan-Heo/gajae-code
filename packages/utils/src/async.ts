/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given message if the timeout fires first.
 * Cleans up all listeners on settlement.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		// The operation has already started, even when cancellation wins immediately.
		void promise.catch(() => {});
		const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
		return Promise.reject(reason);
	}

	const { promise: wrapped, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		reject(new Error(message));
	}, ms);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(
		value => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);

	return wrapped;
}
