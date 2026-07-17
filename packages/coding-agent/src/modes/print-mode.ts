/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `gjc -p "prompt"` - text output
 * - `gjc --mode json "prompt"` - JSON event stream
 */
import { type AssistantMessage, type ImageContent, isContextOverflow } from "@gajae-code/ai";
import { isKnownSinkPeerClosedError, logger, sanitizeText } from "@gajae-code/utils";
import type { AgentSession } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { initializeExtensions } from "./runtime-init";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/**
	 * When true, a terminal assistant error/abort leaves process exit status
	 * untouched so the caller can run its own finalization and status handling.
	 */
	suppressProcessExit?: boolean;
}

/**
 * Exit code used when a non-interactive **text-mode** run (`gjc -p`) terminates
 * because the model context window is exhausted and automatic compaction could
 * not bring the request under the limit. Distinct from the generic failure code
 * (1) so text-mode callers can detect context exhaustion specifically instead of
 * parsing the raw provider error string.
 *
 * Scope: text-mode final-response path only. JSON mode (`--mode json`) streams
 * events from the subscription and does not run this terminal-error branch, so
 * it is intentionally NOT covered by this exit code.
 */
export const CONTEXT_OVERFLOW_EXIT_CODE = 78;

/**
 * Build an actionable stderr diagnostic for a terminal context-overflow error in
 * text mode. The raw provider message is preserved (appended) for debugging, but
 * the leading guidance explains what happened and what the operator can do —
 * tailored to whether auto-compaction was even enabled.
 */
function formatContextOverflowError(message: AssistantMessage, autoCompactionEnabled: boolean): string {
	const providerDetail = message.errorMessage ? ` (provider error: ${sanitizeText(message.errorMessage)})` : "";
	const guidance = autoCompactionEnabled
		? "Context window exhausted: automatic compaction ran but could not reduce the request below the model's context limit. Reduce the input size (smaller file reads / tool output), raise the compaction threshold, or switch to a larger-context model."
		: "Context window exhausted and automatic compaction is disabled. Enable it (compaction.enabled=true with a non-off compaction.strategy) so GJC can compact and continue, reduce the input size, or switch to a larger-context model.";
	return `${guidance}${providerDetail}`;
}

/**
 * Own process stdout only while print mode is actively writing. This lets this
 * mode absorb a peer-closing its output pipe without changing error-listener
 * ownership for the interactive/TUI and clipboard paths.
 */
function createPrintStdoutOwner(): {
	write(chunk: string): void;
	flush(): Promise<void>;
	dispose(): void;
} {
	let epipeLatched = false;
	let writeError: unknown;
	let hasWriteError = false;
	const pendingWrites = new Set<{ done: Promise<void>; settle(): void }>();

	const isEpipe = (error: unknown): boolean => {
		try {
			return (error as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE";
		} catch {
			return false;
		}
	};

	const settlePendingWrites = (): void => {
		for (const pending of [...pendingWrites]) pending.settle();
	};

	const handleWriteError = (error: unknown): void => {
		// An EPIPE from this owned stdout sink proves its peer closed. A destroyed
		// stream does not prove that independently, so it is tolerated only after
		// this owner has already observed and latched an EPIPE.
		if (isEpipe(error)) {
			epipeLatched = true;
			settlePendingWrites();
			return;
		}
		if (epipeLatched && isKnownSinkPeerClosedError(error)) {
			settlePendingWrites();
			return;
		}

		if (!hasWriteError) {
			writeError = error;
			hasWriteError = true;
		}
		settlePendingWrites();
	};

	const onStdoutError = (error: Error): void => {
		handleWriteError(error);
	};
	process.stdout.on("error", onStdoutError);

	const waitForWrites = async (): Promise<void> => {
		while (pendingWrites.size > 0) {
			await Promise.all([...pendingWrites].map(pending => pending.done));
		}
	};

	return {
		write(chunk: string): void {
			if (epipeLatched || hasWriteError) return;

			let settled = false;
			const completion = Promise.withResolvers<void>();
			let pending: { done: Promise<void>; settle(): void };
			pending = {
				done: completion.promise,
				settle: (): void => {
					if (settled) return;
					settled = true;
					pendingWrites.delete(pending);
					completion.resolve();
				},
			};
			const complete = (error?: Error | null): void => {
				if (settled) return;
				if (error) handleWriteError(error);
				pending.settle();
			};

			pendingWrites.add(pending);
			try {
				process.stdout.write(chunk, complete);
			} catch (error) {
				handleWriteError(error);
				pending.settle();
			}
		},

		async flush(): Promise<void> {
			await waitForWrites();
			if (!epipeLatched && !hasWriteError) {
				this.write("");
				await waitForWrites();
			}
			if (hasWriteError) throw writeError;
		},

		dispose(): void {
			process.stdout.removeListener("error", onStdoutError);
		},
	};
}

async function writeStderrAndQuiesce(chunk: string): Promise<void> {
	const completion = Promise.withResolvers<void>();
	let settled = false;
	const complete = (error?: unknown): void => {
		if (settled) return;
		settled = true;
		if (error === undefined || error === null) completion.resolve();
		else completion.reject(error);
	};

	try {
		process.stderr.write(chunk, complete);
	} catch (error) {
		complete(error);
	}
	await completion.promise;
}

function throwCollectedErrors(errors: unknown[]): void {
	const uniqueErrors = [...new Set(errors)];
	if (uniqueErrors.length === 0) return;
	if (uniqueErrors.length === 1) throw uniqueErrors[0];
	throw new AggregateError(uniqueErrors, "Print mode failed while flushing output and disposing the session");
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	const stdout = createPrintStdoutOwner();
	const failures: unknown[] = [];
	let unsubscribe: (() => void) | undefined;

	try {
		// Emit session header for JSON mode.
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) stdout.write(`${JSON.stringify(header)}\n`);
		}

		// Set up extensions for print mode (no UI, no command context).
		await initializeExtensions(session, {
			reportSendError: (action, err) => {
				process.stderr.write(
					`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
				);
			},
			reportRuntimeError: err => {
				process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
			},
		});

		// AgentSession persists events internally. Print mode only needs a listener
		// when it must render the JSON event stream.
		if (mode === "json") {
			unsubscribe = session.subscribe(event => {
				stdout.write(`${JSON.stringify(event)}\n`);
			});
		}

		// Send initial message with attachments.
		if (initialMessage !== undefined) {
			await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
		}

		// Send remaining messages.
		for (const message of messages) {
			await logger.time("print:prompt:next", () => session.prompt(message));
		}

		// In text mode, output final response.
		if (mode === "text") {
			const lastMessage = session.state.messages.findLast(message => message.role === "assistant");
			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				let printContent = true;

				// Check for error/aborted — skip silent-abort (plan-mode compaction transition).
				if (
					(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
					!isSilentAbort(assistantMsg.errorMessage)
				) {
					const isOverflow =
						assistantMsg.stopReason === "error" && isContextOverflow(assistantMsg, session.model?.contextWindow);
					const errorLine = isOverflow
						? formatContextOverflowError(assistantMsg, session.autoCompactionEnabled)
						: sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					const exitCode = isOverflow ? CONTEXT_OVERFLOW_EXIT_CODE : 1;

					if (!options.suppressProcessExit) process.exitCode = exitCode;
					await writeStderrAndQuiesce(`${errorLine}\n`);
					printContent = false;
				}

				if (
					assistantMsg.errorMessage &&
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted"
				) {
					await writeStderrAndQuiesce(`${sanitizeText(assistantMsg.errorMessage)}\n`);
				}

				if (printContent) {
					for (const content of assistantMsg.content) {
						if (content.type === "text") stdout.write(`${sanitizeText(content.text)}\n`);
					}
				}
			}
		}

		// Observe callback and stream errors from every preceding print-mode write.
		await stdout.flush();
	} catch (error) {
		failures.push(error);
	} finally {
		// The JSON subscriber remains live while disposal emits its final events.
		try {
			await session.dispose();
		} catch (error) {
			failures.push(error);
		}

		// Disposal may have written JSON or delivered a late stdout error.
		try {
			await stdout.flush();
		} catch (error) {
			failures.push(error);
		}

		try {
			unsubscribe?.();
		} catch (error) {
			failures.push(error);
		} finally {
			stdout.dispose();
		}
	}

	throwCollectedErrors(failures);
}
