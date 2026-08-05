import { logger } from "@gajae-code/utils";

/** Destination for one-line daemon startup diagnostics; defaults to process stderr. */
export type DaemonDiagnosticSink = (line: string) => void;

export const DAEMON_DIAGNOSTIC_PREFIX = "gjc notify daemon:";

/** `<id>:<secret>` bot tokens must never reach a durable log file. */
const BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;

/** Collapses a reason to one credential-free line. */
export function sanitizeDaemonDiagnostic(reason: string): string {
	return reason.replace(BOT_TOKEN, "<redacted-token>").replace(/\s+/g, " ").trim();
}

/**
 * Records why a daemon child exited (or that it reached readiness). `logger`
 * alone is not enough: a child which exits during startup never flushes that
 * sink, which is why these exits were indistinguishable from "never started"
 * (#3761). The daemon-internal entrypoint therefore passes
 * {@link stderrDaemonDiagnosticSink}, whose output the launcher redirects into
 * `notifications/daemon.log`. Embedded callers pass their own sink, so the
 * daemon class never writes to a host process's stderr on its own.
 */
export function recordDaemonStartupDiagnostic(reason: string, sink?: DaemonDiagnosticSink): void {
	emit("warn", reason, sink);
}

/** Same durable channel as {@link recordDaemonStartupDiagnostic}, for non-failure milestones. */
export function recordDaemonStartupNotice(reason: string, sink?: DaemonDiagnosticSink): void {
	emit("info", reason, sink);
}

/** Writes one timestamped line to stderr, which a daemon child has redirected into its log. */
export const stderrDaemonDiagnosticSink: DaemonDiagnosticSink = line => {
	process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

function emit(level: "warn" | "info", reason: string, sink?: DaemonDiagnosticSink): void {
	const line = `${DAEMON_DIAGNOSTIC_PREFIX} ${sanitizeDaemonDiagnostic(reason)}`;
	if (level === "warn") logger.warn(line);
	else logger.info(line);
	try {
		sink?.(line);
	} catch {
		// A diagnostic must never be able to break the exit path it describes.
	}
}
