/**
 * Crash-log record recovery.
 *
 * The crash log is an append-only text file written by concurrent processes; it
 * is explicitly **not** a parseable database. The field corpus contains at least
 * one interleaved record (two headers merged onto one line), and throwable text
 * is arbitrary multiline content. Recovery therefore trusts only a complete
 * v1 record whose terminal identity line matches a fingerprint recomputed from
 * that record's own header and stack.
 *
 * Records written before that line existed are `unmatchable` and are never
 * offered for reporting — no retroactive mining is attempted or claimed.
 */
import {
	CRASH_FINGERPRINT_VERSION,
	CRASH_RECORD_MARKER,
	type CrashFingerprint,
	type CrashProvenance,
	computeCrashFingerprint,
	computeHandledErrorFingerprint,
	parseCrashRecordMarker,
} from "@gajae-code/utils";

/** A record header: ISO timestamp, pid, label. Starts a new record boundary. */
const RECORD_HEADER = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) pid=\d+ \[[^\]]+\] (.+)$/;

export interface LoadedCrashRecord {
	readonly fingerprint: string;
	readonly fpv: number;
	readonly recordId: string;
	readonly at: number;
	readonly errorName: string;
	readonly messageClass: string;
	/** Record body without the header line and without the identity line. */
	readonly body: string;
	/** The `Name: message` part of the header line. */
	readonly headline: string;
	readonly provenance?: CrashProvenance;
}

interface ParsedCrashRecord {
	record: LoadedCrashRecord;
	complete: boolean;
	bound: boolean;
}

function findBoundFingerprint(
	headline: string,
	bodyLines: string[],
	markerFingerprint: string,
): CrashFingerprint | undefined {
	for (let separator = headline.indexOf(":"); separator > 0; separator = headline.indexOf(":", separator + 1)) {
		const name = headline.slice(0, separator).trim();
		const firstMessageLine = headline.slice(separator + 1).trim();
		for (let continuationCount = 0; continuationCount <= bodyLines.length; continuationCount++) {
			const message = [firstMessageLine, ...bodyLines.slice(0, continuationCount)].join("\n");
			const remaining = bodyLines.slice(continuationCount);
			const stackCandidates = [remaining.join("\n").trimEnd()];
			// Production object payloads are one serialized JSON line appended after
			// the stack. V1 has no explicit delimiter, so also test that one-line
			// suffix omission against the marker rather than trusting its syntax.
			if (remaining.length > 0) stackCandidates.push(remaining.slice(0, -1).join("\n").trimEnd());
			for (const stack of stackCandidates) {
				const input = { name, message, stack };
				const fatalFingerprint = computeCrashFingerprint(input);
				if (fatalFingerprint.fingerprint === markerFingerprint) return fatalFingerprint;
				const handledFingerprint = computeHandledErrorFingerprint(input);
				if (handledFingerprint.fingerprint === markerFingerprint) return handledFingerprint;
			}
		}
	}
	return undefined;
}

/**
 * Parse identity-bearing records out of raw crash-log text.
 *
 * Boundaries are re-established on every header line, so an interleaved or
 * truncated neighbour cannot smear its text into the record that follows.
 */
function parseCandidates(contents: string): ParsedCrashRecord[] {
	const records: ParsedCrashRecord[] = [];
	let headline = "";
	let at = 0;
	let buffer: string[] = [];
	let started = false;
	let provenance: CrashProvenance | undefined;
	let pending: ParsedCrashRecord | undefined;
	for (const line of contents.split("\n")) {
		if (pending) {
			if (line === "") pending.complete = true;
			pending = undefined;
		}
		const header = RECORD_HEADER.exec(line);
		if (header) {
			const parsedAt = Date.parse(header[1] ?? "");
			if (!Number.isFinite(parsedAt)) {
				started = false;
				continue;
			}
			headline = header[2] ?? "";
			const label = line.slice(line.indexOf("[") + 1, line.indexOf("]"));
			const provenanceValue = label
				.split(";")
				.find(part => part.startsWith("provenance="))
				?.slice(11);
			provenance = provenanceValue === "eval" || provenanceValue === "bun_test" ? provenanceValue : undefined;
			at = parsedAt;
			buffer = [];
			started = true;
			continue;
		}
		if (line.startsWith(`${CRASH_RECORD_MARKER} `)) {
			const marker = parseCrashRecordMarker(line);
			if (marker && started) {
				const rawBody = buffer.join("\n").trimEnd();
				const bodyLines = rawBody.split("\n");
				const fingerprint = findBoundFingerprint(headline, bodyLines, marker.fingerprint);
				// A stack's first line repeats `Name: message`, which the header already
				// carries; dropping it keeps the rendered report free of a duplicate.
				const lines = buffer[0]?.trim() === headline.trim() ? buffer.slice(1) : buffer;
				pending = {
					record: {
						fingerprint: marker.fingerprint,
						fpv: marker.version,
						recordId: marker.recordId,
						at,
						errorName: fingerprint?.errorName ?? "Error",
						messageClass: fingerprint?.messageClass ?? "",
						body: lines.join("\n").trimEnd(),
						headline,
						...(provenance === undefined ? {} : { provenance }),
					},
					complete: false,
					bound: marker.version === CRASH_FINGERPRINT_VERSION && fingerprint !== undefined,
				};
				records.push(pending);
			}
			buffer = [];
			started = false;
			continue;
		}
		if (started) buffer.push(line);
	}
	return records;
}

export function parseCrashRecords(contents: string): LoadedCrashRecord[] {
	return parseCandidates(contents).map(candidate => candidate.record);
}

/** Complete v1 records whose marker fingerprint is recomputed from their diagnostic text. */
export function parseRecoverableCrashRecords(contents: string): LoadedCrashRecord[] {
	return parseCandidates(contents)
		.filter(candidate => candidate.complete && candidate.bound)
		.map(candidate => candidate.record);
}

/** Newest identity-bearing record for a fingerprint, or `undefined` when unmatchable. */
export function findLatestRecord(contents: string, fingerprint: string): LoadedCrashRecord | undefined {
	const matches = parseCrashRecords(contents).filter(record => record.fingerprint === fingerprint);
	return matches.at(-1);
}

/** Identity-bearing record bound to the indexed append-order identity. */
export function findRecordById(contents: string, fingerprint: string, recordId: string): LoadedCrashRecord | undefined {
	return parseRecoverableCrashRecords(contents).find(
		record => record.fingerprint === fingerprint && record.recordId === recordId,
	);
}
