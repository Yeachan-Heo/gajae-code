const CLOSED_STDERR_ERROR_CODES = new Set(["EIO", "EPIPE", "EBADF"]);

function isClosedStderrWriteError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false;
	return CLOSED_STDERR_ERROR_CODES.has(error.code);
}

export function safeStderrWrite(message: string): void {
	try {
		process.stderr.write(message);
	} catch (error) {
		if (isClosedStderrWriteError(error)) return;
		throw error;
	}
}
