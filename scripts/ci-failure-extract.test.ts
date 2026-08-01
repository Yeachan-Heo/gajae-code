import { describe, expect, test } from "bun:test";
import { extractFailures, stripTimestamp } from "./ci-failure-extract";

const TS = "2026-07-22T03:18:36.0557475Z ";

describe("stripTimestamp", () => {
	test("removes the runner's ISO prefix", () => {
		expect(stripTimestamp(`${TS}(fail) something`)).toBe("(fail) something");
	});

	test("leaves an unprefixed line untouched", () => {
		expect(stripTimestamp("(fail) something")).toBe("(fail) something");
	});
});

describe("extractFailures", () => {
	// The exact defect that caused ~5% recall: patterns were matched against the
	// raw line, so the timestamp prefix prevented every anchored match.
	test("extracts identities from timestamp-prefixed lines", () => {
		const log = [
			`${TS}(fail) AgentSession auto-compaction > starts a synthetic continuation [25.45ms]`,
			`${TS}(fail) AgentSession auto-compaction > discards the triggering agent_end`,
		].join("\n");

		const { identities } = extractFailures(log);

		expect(identities).toEqual([
			"AgentSession auto-compaction > discards the triggering agent_end",
			"AgentSession auto-compaction > starts a synthetic continuation",
		]);
	});

	test("strips the trailing duration but keeps names containing brackets", () => {
		const log = [
			`${TS}(fail) handles input [with brackets] in the name [1.20ms]`,
			`${TS}(fail) plain name [12s]`,
		].join("\n");

		expect(extractFailures(log).identities).toEqual([
			"handles input [with brackets] in the name",
			"plain name",
		]);
	});

	test("deduplicates an identity that fails more than once", () => {
		const log = [`${TS}(fail) flaky one [1ms]`, `${TS}(fail) flaky one [2ms]`].join("\n");

		const result = extractFailures(log);

		expect(result.failures).toHaveLength(2);
		expect(result.identities).toEqual(["flaky one"]);
	});

	test("records the runner's own fail count", () => {
		const log = [`${TS}(fail) a`, `${TS} 1 fail`, `${TS} 1761 pass`].join("\n");

		expect(extractFailures(log).reportedFailCount).toBe(1);
	});

	// The guard that makes silent under-counting impossible.
	test("flags under-counting when the summary exceeds what was extracted", () => {
		const log = [`${TS}(fail) only one recognised`, `${TS} 6 fail`].join("\n");

		const result = extractFailures(log);

		expect(result.underCounted).toBe(true);
		expect(result.reportedFailCount).toBe(6);
		expect(result.identities).toHaveLength(1);
	});

	test("aggregates multiple summary lines across timestamped invocations", () => {
		const log = [`${TS} 0 fail`, `${TS}(fail) one recognised`, `${TS} 2 fail`].join("\n");

		const result = extractFailures(log);

		expect(result.reportedFailCount).toBe(2);
		expect(result.underCounted).toBe(true);
		expect(result.identities).toEqual(["one recognised"]);
	});

	test("aggregates suite-level error summaries across invocations", () => {
		const log = [`${TS} 2 fail`, `${TS} 1 error`, `${TS} 1 error`].join("\n");

		const result = extractFailures(log);

		expect(result.reportedErrorCount).toBe(2);
		expect(result.underCounted).toBe(false);
	});

	test("does not treat a repeated failure identity as missing output", () => {
		const log = [`${TS}(fail) same test`, `${TS} 1 fail`, `${TS}(fail) same test`, `${TS} 1 fail`].join("\n");

		const result = extractFailures(log);

		expect(result.reportedFailCount).toBe(2);
		expect(result.failures).toHaveLength(2);
		expect(result.identities).toEqual(["same test"]);
		expect(result.underCounted).toBe(false);
	});

	test("does not flag under-counting when extraction agrees with the summary", () => {
		const log = [`${TS}(fail) a`, `${TS}(fail) b`, `${TS} 2 fail`].join("\n");

		expect(extractFailures(log).underCounted).toBe(false);
	});

	// A suite-level error (uncaught exception, failed import) is counted by the
	// runner as a failure but never prints a `(fail) <name>` line, because there
	// is no test to name. Observed in 6 of 1,068 real production logs.
	test("does not flag under-counting when the shortfall is suite-level errors", () => {
		const log = [`${TS} 10 pass`, `${TS} 1 fail`, `${TS} 1 error`].join("\n");

		const result = extractFailures(log);

		expect(result.reportedFailCount).toBe(1);
		expect(result.reportedErrorCount).toBe(1);
		expect(result.identities).toEqual([]);
		expect(result.underCounted).toBe(false);
	});

	test("still flags under-counting when errors do not explain the whole shortfall", () => {
		const log = [`${TS}(fail) one named`, `${TS} 5 fail`, `${TS} 1 error`].join("\n");

		// 5 reported - 1 extracted - 1 error = 3 unexplained.
		expect(extractFailures(log).underCounted).toBe(true);
	});

	test("does not flag under-counting when the log has no summary", () => {
		const result = extractFailures(`${TS}(fail) a`);

		expect(result.reportedFailCount).toBeUndefined();
		expect(result.underCounted).toBe(false);
	});

	// A test *named* after the marker must not be mistaken for a failure; this is
	// the false-positive direction of the same problem.
	test("ignores prose and passing lines that merely mention the marker", () => {
		const log = [
			`${TS}(pass) retries transient errors [40ms]`,
			`${TS}note: the runner prints (fail) for failures`,
			`${TS}(fail) genuinely failing test`,
		].join("\n");

		expect(extractFailures(log).identities).toEqual(["genuinely failing test"]);
	});

	test("returns an empty result for a log with no failures", () => {
		const result = extractFailures(`${TS} 1761 pass\n${TS} 0 fail`);

		expect(result.identities).toEqual([]);
		expect(result.underCounted).toBe(false);
	});

	test("reports the source line number for each failure", () => {
		const log = [`${TS}setup`, `${TS}(fail) second line`].join("\n");

		expect(extractFailures(log).failures[0]).toEqual({ identity: "second line", line: 2 });
	});
});
