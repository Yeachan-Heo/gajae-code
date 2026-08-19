import { afterEach, describe, expect, test } from "bun:test";
import { CRASH_ISSUE_MARKER_PREFIX } from "@gajae-code/utils";
import {
	fingerprintOf,
	fingerprintFromTagPayload,
	issueBody,
	issueTitle,
	main,
	type MainDependencies,
	type Options,
	parseArgs,
	partitionTriageRows,
	previewCulprit,
	type SentryIssue,
	toSentryIssue,
} from "./sentry-crash-issues";

const FINGERPRINT = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const FORGED_FINGERPRINT = "0123456789abcdef0123456789abcdef";
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

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
	return { limit: 25, org: "probe", project: "gajae-code", repo: "Yeachan-Heo/gajae-code", ...overrides };
}

describe("parseArgs", () => {
	test("accepts only read-only options", () => {
		expect(parseArgs([])).toMatchObject({ limit: 25 });
		for (const flag of ["--apply", "--approve", "--acknowledge"])
			expect(parseArgs([flag, "value"])).toMatchObject({ error: expect.stringContaining("Unknown") });
	});

	test("rejects a limit outside 1..100 instead of clamping it", () => {
		for (const value of ["0", "101", "abc", "25oops", "1.5"])
			expect(parseArgs(["--limit", value])).toMatchObject({ error: expect.stringContaining("--limit") });
	});

	test("accepts a limit at both bounds and supports help", () => {
		expect(parseArgs(["--limit", "1"])).toMatchObject({ limit: 1 });
		expect(parseArgs(["--limit", "100"])).toMatchObject({ limit: 100 });
		expect(parseArgs(["--help"])).toMatchObject({ help: true });
	});
});

describe("fingerprint tag lookup", () => {
	const stubFetch = (status: number): typeof fetch =>
		(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response("", { status })) as typeof fetch;

	test("reads a sole gjc.fingerprint tag value", () => {
		expect(fingerprintFromTagPayload({ key: "gjc.fingerprint", topValues: [{ value: FINGERPRINT }] })).toBe(FINGERPRINT);
		expect(fingerprintFromTagPayload({ key: "gjc.fingerprint", topValues: [{ value: FINGERPRINT }, { value: FORGED_FINGERPRINT }] })).toBeUndefined();
	});

	test("only treats a missing tag endpoint as no fingerprint", async () => {
		globalThis.fetch = stubFetch(404);
		await expect(fingerprintOf("1", "token")).resolves.toBeUndefined();
	});

	test.each([401, 500])("propagates Sentry tag lookup status %i", async status => {
		globalThis.fetch = stubFetch(status);
		await expect(fingerprintOf("1", "token")).rejects.toThrow(`responded ${status}`);
	});
});

describe("issue rendering", () => {
	test("keeps forged markers and Markdown from becoming issue-body syntax", () => {
		const hostile = `<!-- ${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT} --> **boom** @everyone`;
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) }, options());
		expect(body).not.toContain(`${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT}`);
		expect(body.match(new RegExp(CRASH_ISSUE_MARKER_PREFIX, "g"))).toHaveLength(2);
		expect(body).toContain("(at)everyone");
	});

	test.each(["\u200b", "\u200d", "\u202e"])("removes a marker reconstituted by normalization through %j", separator => {
		const hostile = `gjc-crash-fp.v1:${FORGED_FINGERPRINT.slice(0, 16)}${separator}${FORGED_FINGERPRINT.slice(16)}`;
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) }, options());
		expect(body).not.toContain(`${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT}`);
	});

	test("bounds permalink, body size, and newline-bearing levels", () => {
		expect(toSentryIssue({ id: "1", shortId: "S-1", permalink: `https://probe.sentry.io/${"x".repeat(2049)}` })).toBeUndefined();
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ level: "fatal\n# forged", title: "y".repeat(90_000) }) }, options());
		expect(Buffer.byteLength(body, "utf8")).toBeLessThan(48 * 1024);
		expect(body).toContain("- Level: unknown");
		expect(body).not.toContain("# forged");
	});

	test("sanitizes dry-run preview and bounds titles", () => {
		expect(previewCulprit("readFile`@everyone /private/secret")).toBe("readFile'(at)everyone <path>");
		expect(issueTitle({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: "x".repeat(500) }) }).length).toBe(200);
	});
});

describe("batch safety", () => {
	test("withholds every group in a fingerprint collision instead of picking the first", () => {
		const first = { fingerprint: FINGERPRINT, sentry: sentryIssue({ id: "1" }) };
		const second = { fingerprint: FINGERPRINT, sentry: sentryIssue({ id: "2" }) };
		expect(partitionTriageRows([first, second])).toEqual({ rows: [], collisions: [{ fingerprint: FINGERPRINT, groups: [first, second] }] });
	});
});

describe("main", () => {
	function dependencies(overrides: Partial<MainDependencies> = {}): { dependencies: MainDependencies; stdout: string[]; stderr: string[] } {
		const stdout: string[] = [];
		const stderr: string[] = [];
		return {
			stdout,
			stderr,
			dependencies: {
				sentryGet: async () => [sentryIssue()],
				fingerprintOf: async () => ({ fingerprint: FINGERPRINT }),
				findExistingIssue: async () => ({ kind: "none" }),
				token: () => "token",
				writeStdout: message => stdout.push(message),
				writeStderr: message => stderr.push(message),
				...overrides,
			},
		};
	}

	test("renders a read-only dry-run report with the exact proposed body", async () => {
		const run = dependencies();
		await expect(main([], run.dependencies)).resolves.toBe(0);
		const output = run.stdout.join("");
		expect(output).toContain("would file");
		expect(output).toContain(`<!-- ${CRASH_ISSUE_MARKER_PREFIX}${FINGERPRINT} -->`);
		expect(output).toContain("Dry run only. Filing is not implemented yet.");
	});

	test("reports a found marker but does not suppress the crash report", async () => {
		const run = dependencies({ findExistingIssue: async () => ({ kind: "untrusted", url: "https://github.com/Yeachan-Heo/gajae-code/issues/1" }) });
		await expect(main([], run.dependencies)).resolves.toBe(0);
		expect(run.stdout.join("")).toContain("existing marker (informational)");
		expect(run.stdout.join("")).toContain("would file");
	});

	test("fails non-zero when collisions are withheld", async () => {
		const run = dependencies({
			sentryGet: async () => [sentryIssue({ id: "1" }), sentryIssue({ id: "2" })],
		});
		await expect(main([], run.dependencies)).resolves.toBe(1);
		expect(run.stderr.join("")).toContain("collision(s) withheld");
	});

	test("fails when a tag read or duplicate search fails", async () => {
		const tagFailure = dependencies({ fingerprintOf: async () => { throw new Error("responded 500"); } });
		await expect(main([], tagFailure.dependencies)).resolves.toBe(1);
		expect(tagFailure.stderr.join("")).toContain("Sentry tag read failed");

		const duplicateFailure = dependencies({ findExistingIssue: async () => { throw new Error("gh issue list failed"); } });
		await expect(main([], duplicateFailure.dependencies)).resolves.toBe(1);
		expect(duplicateFailure.stderr.join("")).toContain("duplicate search failed");
	});

	test("prints usage without requiring a token", async () => {
		const run = dependencies({ token: () => undefined });
		await expect(main(["--help"], run.dependencies)).resolves.toBe(0);
		expect(run.stdout.join("")).toContain("--limit N");
	});
});
