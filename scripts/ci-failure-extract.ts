#!/usr/bin/env bun

/**
 * Extract failing-test identities from CI job logs.
 *
 * Written after a flaky-test audit mined a two-week CI window and recovered a
 * failing-test identity from only 54 of 1,068 failing test jobs (~5%). The other
 * ~1,015 jobs were bucketed as "non-test" purely because the ad-hoc extractor in
 * use at the time never matched their output — their logs did contain ordinary
 * `(fail) <name>` lines. Read literally, that bucket label ("no identity
 * extracted") was mistaken for a finding ("no test failed") and sent two rounds
 * of analysis in the wrong direction.
 *
 * Two properties keep that from recurring:
 *
 *   1. Runner log lines are prefixed with an ISO timestamp, so patterns must be
 *      matched against the stripped line, never the raw one.
 *   2. Bun prints a `<n> fail` summary. When the summary disagrees with the
 *      number of identities extracted, the extraction is under-counting and the
 *      caller is told so rather than silently receiving a short list.
 */

/** A single failing test recovered from a log. */
export interface ExtractedFailure {
	/** Test name exactly as the runner printed it, timing suffix removed. */
	identity: string;
	/** 1-based line number in the source log. */
	line: number;
}

export interface ExtractionResult {
	failures: ExtractedFailure[];
	/** Distinct identities, sorted. */
	identities: string[];
	/** `<n> fail` from the runner's own summary, or undefined when absent. */
	reportedFailCount?: number;
	/**
	 * `<n> error` from the runner's own summary. Bun counts suite-level errors
	 * (an uncaught exception between tests, a failed import) here rather than as
	 * a named `(fail)` line, so they legitimately have no identity to extract.
	 */
	reportedErrorCount?: number;
	/**
	 * True when the runner reported more failures than were extracted AND those
	 * failures are not accounted for by suite-level errors, i.e. the patterns are
	 * genuinely missing named output. Callers should fail closed on this.
	 */
	underCounted: boolean;
}

/** Strips the GitHub Actions ISO-8601 timestamp prefix from a log line. */
const TIMESTAMP = /^\S+Z\s+/;

/**
 * `(fail) <name>` optionally followed by a `[12.34ms]` duration.
 * Anchored so prose merely quoting "(fail)" cannot match.
 */
const BUN_FAIL = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/;

/** Bun's tail summary, e.g. ` 6 fail`. */
const BUN_SUMMARY = /^\s*(\d+)\s+fail\b/;

/** Bun's suite-level error tally, e.g. ` 1 error`. */
const BUN_ERROR_SUMMARY = /^\s*(\d+)\s+error\b/;

export function stripTimestamp(line: string): string {
	return line.replace(TIMESTAMP, "");
}

/**
 * Extracts failing-test identities from a raw CI job log.
 *
 * Accepts the log exactly as the GitHub API returns it — timestamp prefixes and
 * all — so callers cannot forget to normalise first.
 */
export function extractFailures(rawLog: string): ExtractionResult {
	const failures: ExtractedFailure[] = [];
	let reportedFailCount: number | undefined;
	let reportedErrorCount: number | undefined;

	const lines = rawLog.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = stripTimestamp(lines[i] ?? "");

		const fail = BUN_FAIL.exec(line);
		if (fail?.[1]) {
			failures.push({ identity: fail[1].trim(), line: i + 1 });
			continue;
		}

		const summary = BUN_SUMMARY.exec(line);
		if (summary?.[1]) {
			reportedFailCount = (reportedFailCount ?? 0) + Number(summary[1]);
		}

		const errors = BUN_ERROR_SUMMARY.exec(line);
		if (errors?.[1]) {
			reportedErrorCount = (reportedErrorCount ?? 0) + Number(errors[1]);
		}
	}

	const identities = [...new Set(failures.map(f => f.identity))].sort();

	// Compare against extracted failure lines. Identities are deduplicated for
	// reporting, but repeated failures across invocations still account for each
	// invocation's summary count.
	//
	// Suite-level errors are counted by the runner as failures but never print a
	// `(fail) <name>` line — there is no test to name when an import throws or an
	// exception escapes between tests. Allowing for them keeps the guard pointed
	// at genuine pattern gaps instead of firing on a shape it cannot ever match.
	const unexplained = (reportedFailCount ?? 0) - failures.length - (reportedErrorCount ?? 0);
	const underCounted = reportedFailCount !== undefined && unexplained > 0;

	return { failures, identities, reportedFailCount, reportedErrorCount, underCounted };
}

if (import.meta.main) {
	const file = Bun.argv[2];
	if (!file) {
		console.error("usage: bun scripts/ci-failure-extract.ts <job-log-file>");
		process.exit(2);
	}
	const result = extractFailures(await Bun.file(file).text());
	console.log(JSON.stringify(result, null, 2));
	// Fail closed so a regression in the patterns surfaces as a non-zero exit
	// rather than a quietly truncated list.
	if (result.underCounted) {
		console.error(
			`under-counted: runner reported ${result.reportedFailCount} failures, extracted ${result.identities.length}`,
		);
		process.exit(1);
	}
}
