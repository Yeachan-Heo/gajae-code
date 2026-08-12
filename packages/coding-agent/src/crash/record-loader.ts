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
const RECORD_HEADER = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=\d+ \[[^\]]+\] /;

export interface LoadedCrashRecord {
	readonly fingerprint: string;
	readonly fpv: number;
	readonly recordId: string;
	/** Record body without the header line and without the identity line. */
	readonly body: string;
	/** The `Name: message` part of the header line. */
	readonly headline: string;
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
	let buffer: string[] = [];
	let started = false;
	for (const line of contents.split("\n")) {
		if (RECORD_HEADER.test(line)) {
			headline = line.replace(RECORD_HEADER, "");
			buffer = [];
			started = true;
			continue;
		}
		if (line.startsWith(`${CRASH_RECORD_MARKER} `)) {
			const marker = parseCrashRecordMarker(line);
			if (marker && started) {
				// A stack's first line repeats `Name: message`, which the header already
				// carries; dropping it keeps the rendered report free of a duplicate.
				const lines = buffer[0]?.trim() === headline.trim() ? buffer.slice(1) : buffer;
				records.push({
					fingerprint: marker.fingerprint,
					fpv: marker.version,
					recordId: marker.recordId,
					body: lines.join("\n").trimEnd(),
					headline,
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
