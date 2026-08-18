import { describe, expect, test } from "bun:test";
import { CRASH_ISSUE_MARKER_PREFIX } from "@gajae-code/utils";
import {
	fingerprintFromTagPayload,
	issueBody,
	issueTitle,
	type Options,
	parseArgs,
	type SentryIssue,
	toSentryIssue,
} from "./sentry-crash-issues";

const FINGERPRINT = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";

function sentryIssue(overrides: Partial<SentryIssue> = {}): SentryIssue {
	return {
		id: "7677884771",
		shortId: "GAJAE-CODE-1",
		title: "TypeError: cannot read properties of <redacted>",
		culprit: "readFile(packages/coding-agent/src/tools/read.ts)",
		count: "2",
		firstSeen: "2026-08-17",
		lastSeen: "2026-08-18",
		permalink: "https://probe.sentry.io/issues/7677884771/",
		level: "fatal",
		...overrides,
	};
}

function options(overrides: Partial<Options> = {}): Options {
	return { apply: false, limit: 25, org: "probe", project: "gajae-code", repo: "Yeachan-Heo/gajae-code", ...overrides };
}

describe("parseArgs", () => {
	test("defaults to a dry run", () => {
		const parsed = parseArgs([]);
		expect(parsed).toMatchObject({ apply: false });
	});

	test("--apply is the only way to enable writes", () => {
		expect(parseArgs(["--apply"])).toMatchObject({ apply: true });
	});

	test("rejects a limit outside 1..100 instead of clamping it", () => {
		expect(parseArgs(["--limit", "0"])).toMatchObject({ error: expect.stringContaining("--limit") });
		expect(parseArgs(["--limit", "101"])).toMatchObject({ error: expect.stringContaining("--limit") });
		expect(parseArgs(["--limit", "abc"])).toMatchObject({ error: expect.stringContaining("--limit") });
	});

	test("accepts a limit at both bounds", () => {
		expect(parseArgs(["--limit", "1"])).toMatchObject({ limit: 1 });
		expect(parseArgs(["--limit", "100"])).toMatchObject({ limit: 100 });
	});

	test("pins --repo to the one repository the interactive flow searches", () => {
		// A marker filed anywhere else is invisible to checkForDuplicateIssue, so
		// the shared dedup contract would silently stop holding.
		expect(parseArgs(["--repo", "someone/else"])).toMatchObject({ error: expect.stringContaining("pinned") });
		expect(parseArgs(["--repo", "not-a-repo"])).toMatchObject({ error: expect.stringContaining("pinned") });
		expect(parseArgs(["--repo", "Yeachan-Heo/gajae-code"])).toMatchObject({ repo: "Yeachan-Heo/gajae-code" });
	});

	test("rejects an unknown flag rather than ignoring it", () => {
		expect(parseArgs(["--nope", "x"])).toMatchObject({ error: expect.stringContaining("--nope") });
	});

	test("rejects a value-taking flag with no value", () => {
		expect(parseArgs(["--org"])).toMatchObject({ error: expect.stringContaining("--org") });
		expect(parseArgs(["--org", "--apply"])).toMatchObject({ error: expect.stringContaining("--org") });
	});
});

describe("fingerprintFromTagPayload", () => {
	test("reads the top value of the gjc.fingerprint tag", () => {
		expect(fingerprintFromTagPayload({ key: "gjc.fingerprint", topValues: [{ value: FINGERPRINT }] })).toBe(
			FINGERPRINT,
		);
	});

	test("ignores a different tag key", () => {
		expect(fingerprintFromTagPayload({ key: "bun", topValues: [{ value: FINGERPRINT }] })).toBeUndefined();
	});

	test("refuses a value that is not a v1 fingerprint", () => {
		for (const value of [FINGERPRINT.toUpperCase(), FINGERPRINT.slice(0, 31), `${FINGERPRINT}0`, "zzzz"])
			expect(fingerprintFromTagPayload({ key: "gjc.fingerprint", topValues: [{ value }] })).toBeUndefined();
	});

	test("handles a missing or empty topValues without throwing", () => {
		expect(fingerprintFromTagPayload({ key: "gjc.fingerprint" })).toBeUndefined();
		expect(fingerprintFromTagPayload({ key: "gjc.fingerprint", topValues: [] })).toBeUndefined();
		expect(fingerprintFromTagPayload(null)).toBeUndefined();
	});
});

describe("toSentryIssue", () => {
	test("requires both id and shortId", () => {
		expect(toSentryIssue({ shortId: "GAJAE-CODE-1" })).toBeUndefined();
		expect(toSentryIssue({ id: "1" })).toBeUndefined();
	});

	test("truncates timestamps to a date, matching the report flow's coarse dates", () => {
		const issue = toSentryIssue({ id: "1", shortId: "S-1", firstSeen: "2026-08-17T04:05:06.789Z" });
		expect(issue?.firstSeen).toBe("2026-08-17");
	});
});

describe("issue rendering", () => {
	test("embeds the dedup marker so the interactive flow recognizes it later", () => {
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue() }, options());
		expect(body).toContain(`${CRASH_ISSUE_MARKER_PREFIX}${FINGERPRINT}`);
		expect(body.trimEnd().endsWith(`<!-- ${CRASH_ISSUE_MARKER_PREFIX}${FINGERPRINT} -->`)).toBe(true);
	});

	test("carries the upstream group link and counts", () => {
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue() }, options());
		expect(body).toContain("https://probe.sentry.io/issues/7677884771/");
		expect(body).toContain("Upstream events: 2");
	});

	test("bounds the title so a long upstream title cannot exceed GitHub's limit", () => {
		const title = issueTitle({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: "x".repeat(500) }) });
		expect(title.length).toBe(200);
	});

	test("re-sanitizes crash-derived title text locally instead of trusting the relay provenance", () => {
		const hostile = "TypeError: sk-abcdefghijklmnop1234 leaked /home/secret/path in https://evil.example/x?token=abc";
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) }, options());
		expect(body).not.toContain("sk-abcdefghijklmnop1234");
		expect(body).not.toContain("/home/secret/path");
		expect(body).toContain("«url evil.example/x»");
		const title = issueTitle({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) });
		expect(title).toBe("crash: TypeError: «redacted-api-key» leaked <path> in «url evil.example/x»");
	});

	test("de-fangs mentions and backticks in the culprit so a forged group cannot notify or escape rendering", () => {
		const body = issueBody(
			{ fingerprint: FINGERPRINT, sentry: sentryIssue({ culprit: "readFile`@everyone /etc/x" }) },
			options(),
		);
		expect(body).not.toContain("@everyone");
		expect(body).toContain("(at)everyone");
		// The field's own backticks are neutralized; the only remaining backticks
		// around the culprit are the wrapper this script renders.
		expect(body).toContain("Culprit: `readFile'(at)everyone <path>`");
	});

	test("drops a field the residual scanner refuses instead of passing it through", () => {
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ culprit: "a://b data:x;base64,AAAA" }) }, options());
		expect(body).toContain("<unsanitizable culprit>");
		expect(body).not.toContain("base64");
	});

	test("bounds the body so a huge upstream title cannot blow past the issue size budget", () => {
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: "y".repeat(90_000) }) }, options());
		expect(Buffer.byteLength(body, "utf8")).toBeLessThan(48 * 1024);
	});
});
