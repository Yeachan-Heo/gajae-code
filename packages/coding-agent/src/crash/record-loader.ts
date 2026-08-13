/**
 * Crash-log record recovery.
 *
 * The crash log is an append-only text file written by concurrent processes; it
 * is explicitly **not** a parseable database. The field corpus contains at least
 * one interleaved record (two headers merged onto one line), and throwable text
 * is arbitrary multiline content. So this loader claims exactly one thing: a
 * record that carries a `gjc-crash-record.v1` identity line has that identity.
 *
 * Records written before that line existed are `unmatchable` and are never
 * offered for reporting — no retroactive mining is attempted or claimed.
 */
import { CRASH_RECORD_MARKER, parseCrashRecordMarker } from "@gajae-code/utils";

/** A record header: ISO timestamp, pid, label. Starts a new record boundary. */
const RECORD_HEADER = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) pid=\d+ \[[^\]]+\] /;

/**
 * Whether the log ends, or the next record begins, at `position` — ignoring the
 * blank line the writer puts after every identity line. Any other content means
 * the identity line was in the middle of a record rather than closing one.
 */
function isRecordBoundary(lines: readonly string[], position: number): boolean {
	for (let index = position; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.length === 0) continue;
		return RECORD_HEADER.test(line);
	}
	return true;
}

export interface LoadedCrashRecord {
	readonly fingerprint: string;
	readonly fpv: number;
	readonly recordId: string;
	/** Record body without the header line and without the identity line. */
	readonly body: string;
	/** The `Name: message` part of the header line. */
	readonly headline: string;
	/**
	 * Header timestamp in epoch milliseconds, or `undefined` when the header does
	 * not parse as a date. Callers that need a time must handle its absence: the
	 * log is text written by many processes, not a schema.
	 */
	readonly at: number | undefined;
	/**
	 * Whether the identity line sits where `recordFatalCrash` puts it: last in the
	 * record, with only blank lines between it and either the next record header or
	 * the end of the log. Throwable text is arbitrary and can contain a line that
	 * looks like an identity line, and the first such line ends the record here — so
	 * an identity line with more record text after it is one the crash message
	 * chose, not one the writer stamped.
	 *
	 * This is a placement check, not authentication. Text that reproduces the whole
	 * framing can still name a signature; the crash log is a plain-text file the
	 * writer shares with arbitrary throwable content, and nothing in it is a
	 * capability.
	 */
	readonly wellTerminated: boolean;
}

/**
 * Parse identity-bearing records out of raw crash-log text.
 *
 * Boundaries are re-established on every header line, so an interleaved or
 * truncated neighbour cannot smear its text into the record that follows.
 */
export function parseCrashRecords(contents: string): LoadedCrashRecord[] {
	const records: LoadedCrashRecord[] = [];
	let headline = "";
	let at: number | undefined;
	let buffer: string[] = [];
	let started = false;
	const lines = contents.split("\n");
	for (const [position, line] of lines.entries()) {
		const header = RECORD_HEADER.exec(line);
		if (header) {
			headline = line.replace(RECORD_HEADER, "");
			const parsed = Date.parse(header[1] ?? "");
			at = Number.isFinite(parsed) ? parsed : undefined;
			buffer = [];
			started = true;
			continue;
		}
		if (line.startsWith(`${CRASH_RECORD_MARKER} `)) {
			const marker = parseCrashRecordMarker(line);
			if (marker && started) {
				// A stack's first line repeats `Name: message`, which the header already
				// carries; dropping it keeps the rendered report free of a duplicate.
				const body = buffer[0]?.trim() === headline.trim() ? buffer.slice(1) : buffer;
				records.push({
					fingerprint: marker.fingerprint,
					fpv: marker.version,
					recordId: marker.recordId,
					body: body.join("\n").trimEnd(),
					headline,
					at,
					wellTerminated: isRecordBoundary(lines, position + 1),
				});
			}
			buffer = [];
			started = false;
			continue;
		}
		if (started) buffer.push(line);
	}
	return records;
}

/** Newest identity-bearing record for a fingerprint, or `undefined` when unmatchable. */
export function findLatestRecord(contents: string, fingerprint: string): LoadedCrashRecord | undefined {
	const matches = parseCrashRecords(contents).filter(record => record.fingerprint === fingerprint);
	return matches.at(-1);
}
