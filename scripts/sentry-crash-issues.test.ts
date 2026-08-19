import { afterEach, describe, expect, test } from "bun:test";
import { CRASH_ISSUE_MARKER_PREFIX } from "@gajae-code/utils";
import {
	approvalManifest,
	fingerprintOf,
	fingerprintFromTagPayload,
	issueBody,
	issueTitle,
	main,
	type ApprovalManifest,
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
	return {
		apply: false,
		approve: undefined,
		limit: 25,
		org: "probe",
		project: "gajae-code",
		repo: "Yeachan-Heo/gajae-code",
		...overrides,
	};
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
		expect(parseArgs(["--limit", "25oops"])).toMatchObject({ error: expect.stringContaining("--limit") });
		expect(parseArgs(["--limit", "1.5"])).toMatchObject({ error: expect.stringContaining("--limit") });
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

	test("supports a normal help path", () => {
		expect(parseArgs(["--help"])).toMatchObject({ help: true });
	});
});

describe("fingerprintFromTagPayload", () => {
	test("reads the sole gjc.fingerprint tag value", () => {
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

	test("quarantines multi-valued tags instead of selecting one", () => {
		expect(
			fingerprintFromTagPayload({ key: "gjc.fingerprint", topValues: [{ value: FINGERPRINT }, { value: FORGED_FINGERPRINT }] }),
		).toBeUndefined();
	});
});

describe("fingerprint tag lookup", () => {
	// A fetch-shaped mock matching the repo's notify-setup idiom: the async
	// body accepts the real (input, init) parameters so the single `as
	// typeof fetch` cast is structurally sound (a bare () => Promise<Response>
	// is not assignable and previously forced an unsafe double cast).
	const stubFetch = (status: number): typeof fetch =>
		(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response("", { status })) as typeof fetch;

	test("only treats a missing tag endpoint as no fingerprint", async () => {
		globalThis.fetch = stubFetch(404);
		await expect(fingerprintOf("1", "token")).resolves.toBeUndefined();
	});

	test.each([401, 500])("propagates Sentry tag lookup status %i", async status => {
		globalThis.fetch = stubFetch(status);
		await expect(fingerprintOf("1", "token")).rejects.toThrow(`responded ${status}`);
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

	test("drops rows whose metadata fails the ingestion bounds instead of repairing them", () => {
		const valid = { id: "1", shortId: "GAJAE-CODE-1" };
		// numeric/shortId/date/permalink bounds
		expect(toSentryIssue({ ...valid, count: "12abc" })).toBeUndefined();
		expect(toSentryIssue({ ...valid, count: "-1" })).toBeUndefined();
		expect(toSentryIssue({ ...valid, shortId: "bad id!" })).toBeUndefined();
		expect(toSentryIssue({ ...valid, shortId: "x".repeat(33) })).toBeUndefined();
		expect(toSentryIssue({ ...valid, firstSeen: "garbage-day!" })).toBeUndefined();
		expect(toSentryIssue({ ...valid, permalink: "https://evil.example/i?token=1" })).toBeUndefined();
		expect(toSentryIssue({ ...valid, permalink: "javascript:alert(1)" })).toBeUndefined();
	});

	test("reduces a sentry permalink to origin+path with query and fragment stripped", () => {
		const issue = toSentryIssue({
			id: "1",
			shortId: "S-1",
			permalink: "https://probe.sentry.io/issues/1/?query=x#frag",
		});
		expect(issue?.permalink).toBe("https://probe.sentry.io/issues/1/");
	});

	test("rejects a valid-but-oversized Sentry permalink path", () => {
		expect(
			toSentryIssue({ id: "1", shortId: "S-1", permalink: `https://probe.sentry.io/${"x".repeat(2049)}` }),
		).toBeUndefined();
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

	test("keeps forged markers and Markdown from becoming issue-body syntax", () => {
		const hostile = `<!-- ${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT} --> **boom** @everyone`;
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) }, options());
		expect(body).not.toContain(`${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT}`);
		expect(body.match(new RegExp(CRASH_ISSUE_MARKER_PREFIX, "g"))).toHaveLength(2);
		expect(body).toContain("(at)everyone");
		expect(issueTitle({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) })).not.toContain("@everyone");
	});

	test.each(["\u200b", "\u200d", "\u202e"])("removes a marker reconstituted by normalization through %j", separator => {
		const hostile = `gjc-crash-fp.v1:${FORGED_FINGERPRINT.slice(0, 16)}${separator}${FORGED_FINGERPRINT.slice(16)}`;
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) }, options());
		expect(body).not.toContain(`${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT}`);
		expect(body.match(new RegExp(CRASH_ISSUE_MARKER_PREFIX, "g"))).toHaveLength(2);
	});

	test("does not strip a marker prefix that has a word-character suffix", () => {
		const hostile = `${CRASH_ISSUE_MARKER_PREFIX}${FORGED_FINGERPRINT}x`;
		expect(issueTitle({ fingerprint: FINGERPRINT, sentry: sentryIssue({ title: hostile }) })).toContain(hostile);
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
	test("fails closed when a rendered body would exceed GitHub's byte limit", () => {
		expect(() =>
			issueBody(
				{ fingerprint: FINGERPRINT, sentry: sentryIssue({ permalink: `https://probe.sentry.io/${"x".repeat(90_000)}` }) },
				options(),
			),
		).toThrow("issue body exceeds");
	});
	test("does not let a newline-bearing Sentry level restructure Markdown", () => {
		const body = issueBody({ fingerprint: FINGERPRINT, sentry: sentryIssue({ level: "fatal\n# forged" }) }, options());
		expect(body).toContain("- Level: unknown");
		expect(body).not.toContain("# forged");
	});
	test("sanitizes the dry-run culprit preview so a forged group cannot write raw text to the maintainer terminal", () => {
		const culprit = previewCulprit("readFile`@owner /home/secret sk-abcdefghijklmnop1234");
		expect(culprit).not.toContain("@owner");
		expect(culprit).not.toContain("/home/secret");
		expect(culprit).not.toContain("sk-abcdefghijklmnop1234");
		expect(culprit).toContain("(at)owner");
	});
});

describe("batch safety", () => {
	test("withholds every group in a fingerprint collision instead of picking the first", () => {
		const first = { fingerprint: FINGERPRINT, sentry: sentryIssue({ id: "1" }) };
		const second = { fingerprint: FINGERPRINT, sentry: sentryIssue({ id: "2" }) };
		const partitioned = partitionTriageRows([first, second]);
		expect(partitioned.rows).toHaveLength(0);
		expect(partitioned.collisions).toEqual([{ fingerprint: FINGERPRINT, groups: [first, second] }]);
	});

	test("sanitizes the dry-run culprit with the same renderer as issue bodies", () => {
		expect(previewCulprit("readFile`@everyone /private/secret")).toBe("readFile'(at)everyone <path>");
	});
});

describe("main orchestration", () => {
	function mainDependencies(
		trusted: boolean,
		overrides: Partial<MainDependencies> = {},
	): { dependencies: MainDependencies; stdout: string[]; stderr: string[]; ghCalls: readonly string[][] } {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const ghCalls: string[][] = [];
		const approvals: ApprovalManifest[] = trusted
			? [approvalManifest({ fingerprint: FINGERPRINT, sentry: sentryIssue() }, options())]
			: [];
		const filed: { manifest: ApprovalManifest; url: string }[] = [];
		return {
			stdout,
			stderr,
			ghCalls,
			dependencies: {
				sentryGet: async () => [sentryIssue()],
				fingerprintOf: async () => ({ fingerprint: FINGERPRINT, trusted }),
				findExistingIssue: async () => ({ kind: "none" }),
				gh: async args => {
					ghCalls.push([...args]);
					return { ok: true, stdout: "https://github.com/Yeachan-Heo/gajae-code/issues/1\n", stderr: "" };
				},
				token: () => "token",
				approvals: {
					loadApprovals: async () => approvals,
					recordApprovals: async manifests => {
						approvals.push(...manifests);
					},
					consume: async manifest => {
						const index = approvals.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(manifest));
						if (index >= 0) approvals.splice(index, 1);
					},
					hasFiled: async (manifest, url) =>
						filed.some(candidate => candidate.url === url && JSON.stringify(candidate.manifest) === JSON.stringify(manifest)),
					recordFiled: async (manifest, url) => {
						filed.push({ manifest, url });
					},
				},
				withCreationLock: async action => action(),
				writeStdout: message => stdout.push(message),
				writeStderr: message => stderr.push(message),
				...overrides,
			},
		};
	}

	test("reports unverified public-DSN fingerprints and refuses --apply", async () => {
		const { dependencies, stderr, ghCalls } = mainDependencies(false);
		await expect(main(["--apply"], dependencies)).resolves.toBe(1);
		expect(stderr.join("")).toContain("unverified");
		expect(ghCalls).toHaveLength(0);
	});

	test("prints usage for --help without requiring Sentry credentials", async () => {
		const { dependencies, stdout } = mainDependencies(false, { token: () => undefined });
		await expect(main(["--help"], dependencies)).resolves.toBe(0);
		expect(stdout.join("")).toContain("--approve DIGEST");
	});

	test("keeps dry runs read-only and applies trusted rows only with --apply", async () => {
		const dryRun = mainDependencies(true);
		await expect(main([], dryRun.dependencies)).resolves.toBe(0);
		expect(dryRun.ghCalls).toHaveLength(0);
		expect(dryRun.stdout.join("")).toContain("would file");

		const apply = mainDependencies(true);
		await expect(main(["--apply"], apply.dependencies)).resolves.toBe(0);
		expect(apply.ghCalls).toHaveLength(1);
		expect(apply.ghCalls[0]).toContain("create");
	});

	test("fails a mixed batch when a collision needs manual reconciliation", async () => {
		const { dependencies } = mainDependencies(true, {
			sentryGet: async () => [sentryIssue({ id: "1" }), sentryIssue({ id: "2" }), sentryIssue({ id: "3" })],
			fingerprintOf: async issueId => ({
				fingerprint: issueId === "3" ? FORGED_FINGERPRINT : FINGERPRINT,
				trusted: true,
			}),
		});
		await expect(main([], dependencies)).resolves.toBe(1);
	});


	test("missing token, non-array list, and tag-read rejection each fail with no writes", async () => {
		const noToken = mainDependencies(true, { token: () => undefined });
		await expect(main([], noToken.dependencies)).resolves.toBe(2);
		expect(noToken.stderr.join("")).toContain("SENTRY_AUTH_TOKEN");

		const badList = mainDependencies(true, { sentryGet: async () => ({ not: "an array" }) });
		await expect(main([], badList.dependencies)).resolves.toBe(1);
		expect(badList.stderr.join("")).toContain("unexpected issue list shape");

		const tagFailure = mainDependencies(true, {
			fingerprintOf: async () => {
				throw new Error("responded 500");
			},
		});
		await expect(main([], tagFailure.dependencies)).resolves.toBe(1);
		expect(tagFailure.stderr.join("")).toContain("Sentry tag read failed");
		expect(tagFailure.ghCalls).toHaveLength(0);
	});

	test("fails closed when a body-marker search is uncertain or a create fails", async () => {
		// An UNAPPROVED fingerprint with a planted marker stays withheld.
		const bodyMarker = mainDependencies(false, {
			findExistingIssue: async () => ({ kind: "untrusted", url: "https://github.com/Yeachan-Heo/gajae-code/issues/1" }),
		});
		await expect(main(["--apply"], bodyMarker.dependencies)).resolves.toBe(1);
		expect(bodyMarker.stderr.join("")).toContain("acknowledge the exact issue URL");
		expect(bodyMarker.ghCalls).toHaveLength(0);

		// Approval never upgrades an arbitrary body marker into provenance.
		const approvedMarker = mainDependencies(true, {
			findExistingIssue: async () => ({ kind: "untrusted", url: "https://github.com/Yeachan-Heo/gajae-code/issues/1" }),
		});
		await expect(main(["--apply"], approvedMarker.dependencies)).resolves.toBe(1);
		expect(approvedMarker.stderr.join("")).toContain("acknowledge the exact issue URL");
		expect(approvedMarker.ghCalls).toHaveLength(0);

		const duplicate = mainDependencies(true, {
			findExistingIssue: async () => {
				throw new Error("gh issue list returned multiple marker candidates");
			},
		});
		await expect(main(["--apply"], duplicate.dependencies)).resolves.toBe(1);
		expect(duplicate.ghCalls).toHaveLength(0);

		const failedCreate = mainDependencies(true, {
			gh: async () => ({ ok: false, stdout: "", stderr: "forbidden" }),
		});
		await expect(main(["--apply"], failedCreate.dependencies)).resolves.toBe(1);
		expect(failedCreate.stderr.join("")).toContain("failed");
	});

	test("--approve records the reviewed pending set and makes --apply reachable end-to-end", async () => {
		const unapproved = mainDependencies(false);
		const dry = await main([], unapproved.dependencies);
		expect(dry).toBe(1); // unverified: nothing approved yet
		expect(unapproved.stdout.join("")).toContain("--approve ");
		const digestMatch = /--approve ([0-9a-f]{16})/.exec(unapproved.stdout.join(""));
		expect(digestMatch).not.toBeNull();

		const recorded: ApprovalManifest[][] = [];
		const approving = mainDependencies(false, {
			approvals: {
				loadApprovals: async () => [],
				recordApprovals: async manifests => {
					recorded.push([...manifests]);
				},
				consume: async () => {},
				hasFiled: async () => false,
				recordFiled: async () => {},
			},
		});
		await expect(main(["--approve", digestMatch![1]!], approving.dependencies)).resolves.toBe(1);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.[0]?.fingerprint).toBe(FINGERPRINT);

		// After approval, the same batch is fileable and idempotent on rerun.
		const postApproval = mainDependencies(true);
		await expect(main(["--apply"], postApproval.dependencies)).resolves.toBe(0);
		expect(postApproval.ghCalls.length).toBeGreaterThan(0);
	});

	test("rejects an approval when the same fingerprint is replaced with a different reviewed row", async () => {
		const changed = mainDependencies(true, {
			sentryGet: async () => [sentryIssue({ id: "999", title: "replacement group" })],
		});
		await expect(main(["--apply"], changed.dependencies)).resolves.toBe(1);
		expect(changed.ghCalls).toHaveLength(0);
		expect(changed.stderr.join("")).toContain("unverified");
	});

	test("requires URL-bound acknowledgement before a planted marker becomes locally filed", async () => {
		const markerUrl = "https://github.com/Yeachan-Heo/gajae-code/issues/1";
		const setup = mainDependencies(true, {
			findExistingIssue: async () => ({ kind: "untrusted", url: markerUrl }),
		});
		await expect(main(["--acknowledge", markerUrl], setup.dependencies)).resolves.toBe(0);
		await expect(main(["--apply"], setup.dependencies)).resolves.toBe(0);
		expect(setup.ghCalls).toHaveLength(0);
		expect(setup.stdout.join("")).toContain("1 already filed");
	});

	test("serializes the final duplicate check and create across concurrent applies", async () => {
		let locked = false;
		const waiters: { resolve: () => void }[] = [];
		let created = false;
		let creates = 0;
		const shared = mainDependencies(true, {
			findExistingIssue: async () =>
				created
					? { kind: "untrusted", url: "https://github.com/Yeachan-Heo/gajae-code/issues/1" }
					: { kind: "none" },
			gh: async args => {
				expect(args).toContain("create");
				creates++;
				created = true;
				return { ok: true, stdout: "https://github.com/Yeachan-Heo/gajae-code/issues/1\n", stderr: "" };
			},
			withCreationLock: async action => {
				while (locked) {
					const waiter = Promise.withResolvers<void>();
					waiters.push(waiter);
					await waiter.promise;
				}
				locked = true;
				try {
					return await action();
				} finally {
					locked = false;
					waiters.shift()?.resolve();
				}
			},
		});
		const results = await Promise.all([main(["--apply"], shared.dependencies), main(["--apply"], shared.dependencies)]);
		expect(results).toEqual([0, 0]);
		expect(creates).toBe(1);
	});
});
