/**
 * Persistence scrub for the GitHub view cache. Live `getOrFetchIssue` results
 * stay as the API returned them; the sqlite row is what must not keep
 * credential-shaped text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getOrFetchIssue,
	getOrFetchPrDiff,
	type PrDiffPayload,
	parsePrUnifiedDiff,
	scrubPrDiffText,
} from "@gajae-code/coding-agent/tools/gh";
import {
	getCached,
	openDb,
	putCached,
	resetForTests as resetCacheForTests,
} from "@gajae-code/coding-agent/tools/github-cache";
import * as git from "@gajae-code/coding-agent/utils/git";
import fc from "fast-check";

const TEST_REPO = "owner/example";
const TEST_AUTH_KEY = "test-auth";
const GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const API_KEY = "sk-live-CANARY-4f3a2b1c9d8e7f60";
const BEARER_HEX = "8f4c2e1a9b7d6f3e5a0c9b8d7e6f5a4c";
const BEARER = `Bearer ${BEARER_HEX}`;
const SECRETS = [GITHUB_TOKEN, API_KEY, BEARER_HEX];

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-"));
	originalEnv = process.env.GJC_GITHUB_CACHE_DB;
	process.env.GJC_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetCacheForTests();
});

afterEach(async () => {
	resetCacheForTests();
	vi.restoreAllMocks();
	if (originalEnv === undefined) {
		delete process.env.GJC_GITHUB_CACHE_DB;
	} else {
		process.env.GJC_GITHUB_CACHE_DB = originalEnv;
	}
	await fs.rm(tempDir, { recursive: true, force: true });
});

function issuePayload(number: number, body: string, url: string) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url,
		labels: [],
		comments: [] as Array<{ author: { login: string }; body: string }>,
	};
}

async function persistedCacheBytes(): Promise<string> {
	return cacheFileBytes();
}

function cacheFileBytes(): string {
	const dbPath = process.env.GJC_GITHUB_CACHE_DB;
	if (!dbPath) throw new Error("GJC_GITHUB_CACHE_DB is unset");
	const parts: Buffer[] = [];
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			parts.push(readFileSync(dbPath + suffix));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	return Buffer.concat(parts).toString("utf8");
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const ordinaryWord = fc.stringMatching(/^[a-z]{1,8}$/);
const ordinaryText = fc.stringMatching(/^[a-z](?:[a-z ]{0,20})?$/);
const { value: nestedValue } = fc.letrec<{ value: JsonValue }>(tie => ({
	value: fc.oneof(
		{ depthSize: "small" },
		ordinaryText,
		fc.integer({ min: -50, max: 50 }),
		fc.boolean(),
		fc.constant(null),
		fc.array(tie("value"), { maxLength: 3 }),
		fc.dictionary(ordinaryWord, tie("value"), { maxKeys: 3 }),
	),
}));
const credentialBody = fc.stringMatching(/^[A-Za-z0-9]{20}$/);
const credentialText = fc.oneof(
	credentialBody.map(body => `ghp_${body}`),
	credentialBody.map(body => `sk-${body}`),
	credentialBody.map(body => `Bearer ${body}`),
);

describe("github view cache persistence", () => {
	it("still allows an ordinary issue body to round-trip in the view cache", async () => {
		const body = "Build failed on Tuesday. See the checklist.";
		const url = `https://github.com/${TEST_REPO}/issues/41`;
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(41, body, url) as never);

		const live = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "41",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(live.status).toBe("miss");
		expect(live.payload.body).toBe(body);
		expect(live.rendered).toContain(body);
		expect(live.sourceUrl).toBe(url);

		const cached = getCached(TEST_REPO, "issue", 41, true, TEST_AUTH_KEY);
		expect(cached?.rendered).toContain(body);
		expect(cached?.sourceUrl).toBe(url);
		expect((cached?.payload as { body?: string }).body).toBe(body);
		expect(await persistedCacheBytes()).toContain(body);

		const again = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "41",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(again.status).toBe("fresh");
		expect(again.rendered).toBe(live.rendered);
		expect(again.payload.body).toBe(body);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("still allows a filesystem path in the cached issue text", async () => {
		const body = "See /srv/app/config.yml for the layout.";
		const url = `https://github.com/${TEST_REPO}/issues/43`;
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(43, body, url) as never);

		const live = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "43",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(live.rendered).toContain("/srv/app/config.yml");

		const cached = getCached(TEST_REPO, "issue", 43, true, TEST_AUTH_KEY);
		expect(cached?.rendered).toContain("/srv/app/config.yml");
		expect((cached?.payload as { body?: string }).body).toContain("/srv/app/config.yml");
		expect(await persistedCacheBytes()).toContain("/srv/app/config.yml");

		const again = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "43",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(again.status).toBe("fresh");
		expect(again.rendered).toBe(live.rendered);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("still allows the live issue view to include a pasted token", async () => {
		const body = `pasted ${GITHUB_TOKEN} and ${API_KEY}`;
		const url = `https://api.github.com/repos/${TEST_REPO}/issues/44?access_token=${GITHUB_TOKEN}`;
		const payload = issuePayload(44, body, url);
		payload.comments = [{ author: { login: "octocat" }, body: `Authorization: ${BEARER}` }];
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(payload as never);

		const live = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "44",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(live.status).toBe("miss");
		expect(live.rendered).toContain(GITHUB_TOKEN);
		expect(live.rendered).toContain(API_KEY);
		expect(live.rendered).toContain(BEARER_HEX);
		expect(live.payload.body).toContain(GITHUB_TOKEN);
		expect(live.sourceUrl).toContain(GITHUB_TOKEN);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("persisted view cache drops a pasted github token", async () => {
		const body = `pasted ${GITHUB_TOKEN} and ${API_KEY}`;
		const url = `https://api.github.com/repos/${TEST_REPO}/issues/42?access_token=${GITHUB_TOKEN}`;
		const payload = issuePayload(42, body, url);
		payload.comments = [{ author: { login: "octocat" }, body: `Authorization: ${BEARER}` }];
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(payload as never);

		const live = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "42",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(live.status).toBe("miss");
		expect(live.rendered).toContain(GITHUB_TOKEN);
		expect(live.sourceUrl).toContain(GITHUB_TOKEN);

		const disk = await persistedCacheBytes();
		for (const secret of SECRETS) {
			expect(disk).not.toContain(secret);
		}

		const cached = getCached(TEST_REPO, "issue", 42, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		const stored = `${cached?.rendered}\n${cached?.sourceUrl ?? ""}\n${JSON.stringify(cached?.payload)}`;
		for (const secret of SECRETS) {
			expect(stored).not.toContain(secret);
		}
		expect(cached?.rendered).toContain("Issue #42");

		const again = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "42",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(again.status).toBe("fresh");
		expect(spy).toHaveBeenCalledTimes(1);
		for (const secret of SECRETS) {
			expect(again.rendered).not.toContain(secret);
			expect(again.sourceUrl ?? "").not.toContain(secret);
			expect(JSON.stringify(again.payload)).not.toContain(secret);
		}
		spy.mockRestore();
	});

	it("still allows a multiline issue body to round-trip in the view cache", async () => {
		const body = "Build failed on Tuesday.\nSee the checklist.\r\nNext step.";
		const url = `https://github.com/${TEST_REPO}/issues/45`;
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(45, body, url) as never);

		const live = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "45",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		const again = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "45",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(again.status).toBe("fresh");
		expect(again.payload.body).toBe(body);
		expect(again.rendered).toBe(live.rendered);
		expect((getCached(TEST_REPO, "issue", 45, true, TEST_AUTH_KEY)?.payload as { body?: string }).body).toBe(body);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("persisted view cache drops a token glued to a line break", async () => {
		const glued = (secret: string) => `\n${secret}\r\n${secret}\t${secret}`;
		const body = `Example:${glued(GITHUB_TOKEN)}${glued(API_KEY)}${glued(BEARER)}`;
		const url = `https://github.com/${TEST_REPO}/issues/46`;
		const payload = issuePayload(46, body, url);
		payload.comments = [
			{ author: { login: "octocat" }, body: `comment:${glued(GITHUB_TOKEN)}${glued(API_KEY)}${glued(BEARER)}` },
		];
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(payload as never);

		const live = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "46",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(live.status).toBe("miss");
		expect(live.rendered).toContain(GITHUB_TOKEN);
		expect(live.payload.body).toContain(`\n${GITHUB_TOKEN}`);

		const disk = await persistedCacheBytes();
		for (const secret of SECRETS) expect(disk).not.toContain(secret);

		const again = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "46",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(again.status).toBe("fresh");
		expect(spy).toHaveBeenCalledTimes(1);
		const stored = `${again.rendered}\n${JSON.stringify(again.payload)}`;
		for (const secret of SECRETS) expect(stored).not.toContain(secret);
		spy.mockRestore();
	});

	it("persisted view cache drops a token inside a multi-file pull request diff", async () => {
		const diff = [
			"diff --git a/a b/a",
			"index 1111111..2222222 100644",
			"--- a/a",
			"+++ b/a",
			"@@ -1 +1,2 @@",
			" same",
			`+${GITHUB_TOKEN}`,
			"diff --git a/b b/b",
			"index 3333333..4444444 100644",
			"--- a/b",
			"+++ b/b",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		const spy = vi.spyOn(git.github, "text").mockResolvedValue(diff as never);
		const lookup = {
			cwd: tempDir,
			repo: TEST_REPO,
			number: 9,
			cacheAuthKey: TEST_AUTH_KEY,
		};

		const live = await getOrFetchPrDiff(lookup);
		expect(live.status).toBe("miss");
		expect(live.payload.unified).toContain(GITHUB_TOKEN);
		expect(live.rendered).toContain(GITHUB_TOKEN);

		expect(await persistedCacheBytes()).not.toContain(GITHUB_TOKEN);

		const again = await getOrFetchPrDiff(lookup);
		expect(again.status).toBe("fresh");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(again.rendered).toBe(again.payload.unified);
		expect(again.payload.unified).not.toContain(GITHUB_TOKEN);
		expect(again.payload.files).toHaveLength(2);
		const slices = again.payload.files.map(file => again.payload.unified.slice(file.startOffset, file.endOffset));
		expect(slices[0]?.startsWith("diff --git a/a b/a")).toBe(true);
		expect(slices[0]).not.toContain("diff --git a/b b/b");
		expect(slices[1]?.startsWith("diff --git a/b b/b")).toBe(true);
		expect(slices[1]).not.toContain(GITHUB_TOKEN);
		expect(slices[1]).toContain("+new");
		spy.mockRestore();
	});

	it("cache write and read drop a token-shaped string from the body", () => {
		const body = `The CI job printed ${GITHUB_TOKEN} in the log.`;
		const url = `https://github.com/${TEST_REPO}/issues/60`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 60,
			includeComments: true,
			payload: issuePayload(60, body, url),
			rendered: `# Issue #60\n\n${body}`,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 60, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		expect(cached?.rendered).not.toContain(GITHUB_TOKEN);
		expect(cached?.payload.body).not.toContain(GITHUB_TOKEN);
		expect(cacheFileBytes()).not.toContain(GITHUB_TOKEN);
	});

	it("cache write and read drop credentials embedded in a URL", () => {
		const authenticatedUrl = `https://octocat:${GITHUB_TOKEN}@github.com/${TEST_REPO}.git`;
		const body = `Clone with \`git clone ${authenticatedUrl}\`.`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 62,
			includeComments: true,
			payload: issuePayload(62, body, authenticatedUrl),
			rendered: `# Issue #62\n\n${body}`,
			sourceUrl: authenticatedUrl,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 62, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		expect(cached?.sourceUrl).not.toContain(GITHUB_TOKEN);
		expect(cached?.rendered).not.toContain(GITHUB_TOKEN);
		expect(cached?.payload.body).not.toContain(GITHUB_TOKEN);
		expect(cached?.sourceUrl).toBe(`https://github.com/${TEST_REPO}.git`);
		expect(cached?.rendered).toContain(`https://github.com/${TEST_REPO}.git`);
		expect(cacheFileBytes()).not.toContain(GITHUB_TOKEN);
	});

	it("cache write and read drop userinfo in escaped and protocol-relative URLs", () => {
		const body = [
			`json https:\\/\\/octocat:${GITHUB_TOKEN}@github.com/${TEST_REPO}.git`,
			`schemeless //octocat:${GITHUB_TOKEN}@github.com/${TEST_REPO}.git`,
		].join("\n");
		const url = `https://github.com/${TEST_REPO}/issues/67`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 67,
			includeComments: true,
			payload: issuePayload(67, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 67, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		expect(cached?.rendered).not.toContain(GITHUB_TOKEN);
		expect(cached?.rendered).not.toContain("octocat");
		expect(cached?.rendered).toContain("https:\\/\\/github.com");
		expect(cached?.rendered).toContain("//github.com");
	});

	it("removes scheme-relative and assignment-embedded URL userinfo", () => {
		const body = [
			"url=//octocat:opaque-demo-value@example.test/x",
			"https://octocat:token=opaque-demo-value@example.test/docs",
			"//user':opaque-demo-value@example.test/x",
		].join("\n");
		const url = `https://github.com/${TEST_REPO}/issues/74`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 74,
			includeComments: true,
			payload: issuePayload(74, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 74, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).toContain("url=//example.test/x");
		expect(cached?.payload.body).toContain("https://example.test/docs");
		expect(cached?.payload.body).toContain("//example.test/x");
		expect(cached?.payload.body).not.toContain("opaque-demo-value");
	});

	it("rejects a malformed pull request diff row instead of serving it", () => {
		const url = `https://github.com/${TEST_REPO}/pull/75`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 75,
			includeComments: false,
			payload: { rendered: `\\164oken=${GITHUB_TOKEN}` },
			rendered: `\\164oken=${GITHUB_TOKEN}`,
			sourceUrl: url,
			fetchedAt: 1,
		});
		// The write is skipped entirely: no row, so nothing can be served.
		expect(getCached(TEST_REPO, "pr-diff", 75, false, TEST_AUTH_KEY)).toBeNull();

		// A malformed row written by an older binary is rejected on read too.
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 75,
			includeComments: false,
			payload: { unified: "", files: [] },
			rendered: "",
			fetchedAt: 1,
		});
		const db = openDb();
		expect(db).not.toBeNull();
		db?.prepare(
			"UPDATE github_view_cache SET payload = ?, rendered = ? WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
		).run(
			JSON.stringify({ rendered: `\\164oken=${GITHUB_TOKEN}` }),
			`\\164oken=${GITHUB_TOKEN}`,
			TEST_AUTH_KEY,
			TEST_REPO,
			"pr-diff",
			75,
			0,
		);
		expect(getCached(TEST_REPO, "pr-diff", 75, false, TEST_AUTH_KEY)).toBeNull();
	});

	it("drops an escaped quote inside a quoted credential value", () => {
		const body = '{"token":"prefix\\"suffix","keep":1}';
		const url = `https://github.com/${TEST_REPO}/issues/76`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 76,
			includeComments: true,
			payload: issuePayload(76, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 76, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).toBe('{"token":"«redacted»","keep":1}');
	});

	it("cache write and read drop an absolute host path", () => {
		const hostPath = path.join(os.homedir(), "gjc-private", "deploy.yml");
		const body = `Local config lives at ${hostPath}.`;
		const url = `https://github.com/${TEST_REPO}/issues/63`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 63,
			includeComments: true,
			payload: issuePayload(63, body, url),
			rendered: `# Issue #63\n\n${body}`,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 63, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		expect(cached?.rendered).not.toContain(hostPath);
		expect(cached?.payload.body).not.toContain(hostPath);
		expect(cached?.rendered).toContain("~/gjc-private/deploy.yml");
		expect(cacheFileBytes()).not.toContain(hostPath);
	});

	it("cache read scrubs a row written before the fix", () => {
		const hostPath = path.join(os.homedir(), "gjc-legacy", "notes.md");
		const url = `https://github.com/${TEST_REPO}/issues/64`;
		const body = `token ${GITHUB_TOKEN}\npath ${hostPath}\nurl https://octocat:${GITHUB_TOKEN}@github.com/${TEST_REPO}.git`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 64,
			includeComments: true,
			payload: issuePayload(64, "placeholder", url),
			rendered: "placeholder",
			sourceUrl: url,
			fetchedAt: 1,
		});
		// Simulate a row persisted by an older binary: bypass the scrub entirely.
		const db = openDb();
		expect(db).not.toBeNull();
		db?.prepare(
			"UPDATE github_view_cache SET payload = ?, rendered = ?, source_url = ? WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
		).run(
			JSON.stringify(issuePayload(64, body, url)),
			`# Issue #64\n\n${body}`,
			url,
			TEST_AUTH_KEY,
			TEST_REPO,
			"issue",
			64,
			1,
		);

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 64, true, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		const packed = `${cached?.rendered}\n${cached?.sourceUrl ?? ""}\n${JSON.stringify(cached?.payload)}`;
		expect(packed).not.toContain(GITHUB_TOKEN);
		expect(packed).not.toContain(hostPath);
		expect(cached?.payload.body).toContain("~/gjc-legacy/notes.md");
	});

	it("cache read reindexes a pull request diff row written before the fix", () => {
		const diff = [
			"diff --git a/a b/a",
			"index 1111111..2222222 100644",
			"--- a/a",
			"+++ b/a",
			"@@ -1 +1,2 @@",
			" same",
			`+${GITHUB_TOKEN}`,
			"diff --git a/b b/b",
			"index 3333333..4444444 100644",
			"--- a/b",
			"+++ b/b",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 64,
			includeComments: false,
			payload: parsePrUnifiedDiff(""),
			rendered: "",
			fetchedAt: 1,
		});
		const db = openDb();
		expect(db).not.toBeNull();
		db?.prepare(
			"UPDATE github_view_cache SET payload = ?, rendered = ? WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
		).run(JSON.stringify(parsePrUnifiedDiff(diff)), diff, TEST_AUTH_KEY, TEST_REPO, "pr-diff", 64, 0);

		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 64, false, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		expect(cached?.rendered).not.toContain(GITHUB_TOKEN);
		expect(cached?.payload.unified).not.toContain(GITHUB_TOKEN);
		expect(cached?.payload.unified).not.toContain("A1b2C3d4");
		expect(cached?.payload.unified).not.toContain("8f4c2e1a9b7d6f3e5a0c9b8d7e6f5a4c");
		expect(cacheFileBytes()).not.toContain("8f4c2e1a9b7d6f3e5a0c9b8d7e6f5a4c");
		expect(cached?.payload.files).toHaveLength(2);
		const slices = (cached?.payload.files ?? []).map(file =>
			cached?.payload.unified.slice(file.startOffset, file.endOffset),
		);
		expect(slices[0]?.startsWith("diff --git a/a b/a")).toBe(true);
		expect(slices[1]?.startsWith("diff --git a/b b/b")).toBe(true);
		expect(slices[1]).not.toContain(GITHUB_TOKEN);
	});

	it("scrubs a credential hidden by a Git-quoted diff path escape", () => {
		const secret = "opaque-cache-value-1234567890";
		// `\164` decodes to `t`; the raw text has no `token` label, so only a
		// decode-then-scrub can remove the value. The second section proves the
		// rebuilt offsets still bound each file after the first path shrinks.
		const encodedPath = `\\164oken=${secret}`;
		const diff = [
			`diff --git "a/${encodedPath}" "b/${encodedPath}"`,
			"new file mode 100644",
			"--- /dev/null",
			`+++ "b/${encodedPath}"`,
			"@@ -0,0 +1 @@",
			"+content",
			"diff --git a/second b/second",
			"index 5555555..6666666 100644",
			"--- a/second",
			"+++ b/second",
			"@@ -1 +1 @@",
			"+tail",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 65,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(secret);
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 65, false, TEST_AUTH_KEY);
		expect(cached).not.toBeNull();
		const packed = `${cached?.rendered}\n${JSON.stringify(cached?.payload)}`;
		expect(packed).not.toContain(secret);
		expect(cached?.payload.files).toHaveLength(2);
		const [first, second] = cached?.payload.files ?? [];
		expect(first?.path).not.toContain(secret);
		expect(first?.path).toContain("token=«redacted»");
		expect(cached?.payload.unified.slice(first?.startOffset, first?.endOffset).startsWith("diff --git ")).toBe(true);
		expect(
			cached?.payload.unified
				.slice(second?.startOffset, second?.endOffset)
				.startsWith("diff --git a/second b/second"),
		).toBe(true);
		expect(cached?.payload.unified.slice(second?.startOffset, second?.endOffset)).toContain("+tail");
	});

	it("keeps a mixed-quoting diff header and an unquoted path intact", () => {
		const secret = "opaque-cache-value-1234567890";
		const diff = [
			`diff --git "a/token=${secret}" b/token-placeholder`,
			"index 1111111..2222222 100644",
			`--- "a/token=${secret}"`,
			"+++ b/token-placeholder",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			`diff --git a/env/token=${secret} b/env/token=${secret}`,
			"index 3333333..4444444 100644",
			`--- a/env/token=${secret}`,
			`+++ b/env/token=${secret}`,
			"@@ -1 +1 @@",
			"-old",
			"+new",
			`diff --git a/plain "b/\\164oken=${secret}"`,
			"index 5555555..6666666 100644",
			"--- a/plain",
			`+++ "b/\\164oken=${secret}"`,
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 68,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(secret);
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 68, false, TEST_AUTH_KEY);
		const files = cached?.payload.files ?? [];
		expect(files).toHaveLength(3);
		expect(files[0]?.path).toBe("token-placeholder");
		expect(files[0]?.oldPath).toBe("token=«redacted»");
		expect(files[1]?.path).toBe("env/token=«redacted»");
		expect(files[2]?.path).toBe("token=«redacted»");
		for (const file of files) {
			expect(cached?.payload.unified.slice(file.startOffset, file.endOffset).startsWith("diff --git ")).toBe(true);
		}
	});

	it("scans binary diff headers and keeps their shape", () => {
		const secret = "opaque-cache-value-1234567890";
		// `\164` decodes to `t`, so the prose pass cannot see the label.
		const encoded = `\\164oken=${secret}`;
		const diff = [
			`diff --git "a/${encoded}" "b/${encoded}"`,
			`Binary files "a/${encoded}" and "b/${encoded}" differ`,
			"diff --git a/unchanged b/unchanged",
			`Binary files /dev/null and "b/${encoded}" differ`,
			`Binary files a/report and notes and "b/${encoded}" differ`,
			`Binary files a/plain and b/token='left and ${secret}' differ`,
			`Binary files a/plain and "b/name\\ntoken=${secret} and b/suffix" differ`,
			`Binary files a/token='left and b/right' and /dev/null differ`,
			`Binary files a/token='left and /dev/null-demo-canary' and b/token='left and /dev/null-demo-canary' differ`,
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 69,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(secret);
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 69, false, TEST_AUTH_KEY);
		expect(cached?.payload.unified).not.toContain(secret);
		expect(cached?.payload.unified).toContain("differ");
		expect(cached?.payload.unified).toContain("/dev/null");
		expect(cached?.payload.unified).toContain("diff --git a/unchanged b/unchanged");
		expect(cached?.payload.unified).not.toContain("demo-canary");
	});

	it("redacts a token after an invalid UTF-8 escape in a quoted path", () => {
		const diff = [
			`diff --git "a/${"\\377"}${GITHUB_TOKEN}" "b/${"\\377"}${GITHUB_TOKEN}"`,
			`diff --git "a/${"\\377\\t"}${GITHUB_TOKEN}" "b/${"\\377\\t"}${GITHUB_TOKEN}"`,
			`diff --git "a/${"\\377\\147"}${GITHUB_TOKEN.slice(1)}" "b/${"\\377\\147"}${GITHUB_TOKEN.slice(1)}"`,
			`diff --git "a/${"\\377\\t"}Bearer 8f4c2e1a9b7d6f3e5a0c9b8d7e6f5a4c" "b/${"\\377\\t"}Bearer 8f4c2e1a9b7d6f3e5a0c9b8d7e6f5a4c"`,
			"new file mode 100644",
			"--- /dev/null",
			`+++ "b/${"\\377"}${GITHUB_TOKEN}"`,
			"@@ -0,0 +1 @@",
			"+x",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 96,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(GITHUB_TOKEN);
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 96, false, TEST_AUTH_KEY);
		expect(cached?.payload.unified).not.toContain(GITHUB_TOKEN);
	});

	it("keeps unquoted operand spaces and replacement metacharacters", () => {
		const secret = "opaque-cache-value-1234567890";
		const diff = [
			"diff --git a/file with spaces b/file with spaces",
			"index 1111111..2222222 100644",
			"--- a/file with spaces",
			"+++ b/file with spaces",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			`diff --git "a/$&-token=${secret}" "b/$&-token=${secret}"`,
			"index 3333333..4444444 100644",
			`--- "a/$&-token=${secret}"`,
			`+++ "b/$&-token=${secret}"`,
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 77,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(secret);
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 77, false, TEST_AUTH_KEY);
		const files = cached?.payload.files ?? [];
		expect(files).toHaveLength(2);
		expect(files[0]?.path).toBe("file with spaces");
		expect(files[1]?.path).toBe("$&-token=«redacted»");
		expect(cached?.payload.unified).not.toContain("gjc-");
	});

	it("keeps structured credential containers out of the cache", () => {
		const cases = [
			['{"token":[1,2],"keep":1}', '{"token":"«redacted»","keep":1}'],
			['{"token":{"value":"demo"},"keep":1}', '{"token":"«redacted»","keep":1}'],
			['{"token":{"note":"left}opaque-demo-value"},"keep":1}', '{"token":"«redacted»","keep":1}'],
			['{"token":[[1,2],"demo"],"keep":1}', '{"token":"«redacted»","keep":1}'],
			[
				'{"token":{"password":{"example":"demo"},"note":"opaque-demo-value"},"keep":1}',
				'{"token":"«redacted»","keep":1}',
			],
			['{"token":{"note":"demo"}}', '{"token":"«redacted»"}'],
			['{"token":{"note":"opaque-demo-value"', '{"token":"«redacted»"'],
			['{"token": {\n"note":"opaque-demo-value"', '{"token": "«redacted»"'],
			['{"token": [\n\n"opaque-demo-value"\n', '{"token": "«redacted»"'],
			['"token": [\n  "opaque-cache-canary-123"', '"token": "«redacted»"'],
			['"token": [\n  "opaque-demo-value"\ndiff --git a/x b/x\n"opaque-more"', '"token": "«redacted»"'],
		];
		cases.forEach(([body, expected], index) => {
			const number = 90 + index;
			const url = `https://github.com/${TEST_REPO}/issues/${number}`;
			putCached({
				authKey: TEST_AUTH_KEY,
				repo: TEST_REPO,
				kind: "issue",
				number,
				includeComments: true,
				payload: issuePayload(number, body as string, url),
				rendered: body as string,
				sourceUrl: url,
				fetchedAt: 1,
			});
			const cached = getCached<{ body?: string }>(TEST_REPO, "issue", number, true, TEST_AUTH_KEY);
			expect(cached?.payload.body).toBe(expected);
		});
	});

	it("strips userinfo from escaped scheme-relative links and keeps table cells apart", () => {
		const body = [
			"json \\/\\/user:opaque@host/x",
			"https://alice:demo|value@example.test/x",
			"https://alice:opaque|canary|value@example.test/y",
			"first|second",
			"---|---",
			"https://docs.example|'person@example.test'",
			"+https://sample-user:sample-pass@example.test/x|keep",
			"|//docs.example|'person@example.test'|",
			"|https://alice:pa\\|ss@example.test/z|keep|",
			"~~~",
			"```",
			"~~~",
			"",
			"| URL | contact |",
			"|---|---|",
			"|https://docs.example|person@example.test|",
			"```text\r\nhttps://alice:demo|value@example.test/x\r\n---|---\r\n```\r\n",
			"```text\r\n|https://alice:demo|value@example.test/x|\r\n```\r\n",
			"```text\n    ```\r\n|https://alice:demo|value@example.test/x|\r\n```\n",
			"- item\n\n    ```text\n    |https://alice:demo|value@example.test/x|\n    ```\n",
			"plain text\n\n    |https://alice:demo|value@example.test/x|\r\n",
			"10. Item\n\n    | URL | Contact |\n    |---|---|\n    |https://docs.example|person@example.test|",
			"- item\n\n      |https://alice:demo|value@example.test/x|",
			"- item\n\n    |https://alice:demo|value@example.test/x|",
			"```\n- item\n  ```\n\n    |https://alice:demo|value@example.test/x|",
			"- item\n\n```\nliteral\n```\n\n    | A | B |\n    |---|---|\n    |https://alice:demo|value@example.test/x|",
			"- item\n\n      |https://alice:demo|value@example.test/x|\n      |---|---|",
			'"token": [\n    ] https://cache-user:demo|opaque@example.test/x\n---|---|---',
			'| a | b |\n| --- | --- |\n| "token": [\n\n  "array-fixture"\n] |\nhttps://alice:demo|value@example.test/x',
			'# "token": ["dummy|split"]\n---|---\nhttps://cache-user:demo|opaque@example.test/x',
			"+https://example-user:demo-password@example.test/x\n-https://example-user:other-password@example.test/y",
			"xghp_0123456789012345file://localhost/home/cache-fixture/private.txt",
			"xghp_012345678901234Afile://localhost/home/cache-fixture/private.txt",
			"ghp_0123456789012345file://localhost/home/cache-fixture/private.txt",
			`ghp_0123456789012345${os.homedir()}/private.txt`,
			String.raw`C:\Users\Jane Doe. Bearer /dGVzdC1maXh0dXJl`,
			String.raw`C:\Users\Jane Doe. Cookie: sid=persist-cookie-canary-X2m8`,
			String.raw`C:\Users\Jane Doe. Authorization: Negotiate Y2FjaGU6Y2FuYXJ5`,
			'Authorization: Digest username="fixture", realm="example.test", nonce="fixture-nonce", uri="/resource", response="6629fae49393a05397450978507c4ef1"',
			"Authorization: Digest fixture; -----BEGIN PRIVATE KEY-----\nMIIQ2FjaGVPbmx5U3ludGhldGljRml4dHVyZQ==\n-----END PRIVATE KEY-----",
			String.raw`C:\Users\Jane Doe. Proxy-Authorization: Digest username="fixture", realm="example.test", response="6629fae49393a05397450978507c4ef1"`,
			String.raw`C:\Users\Jane Doe. Set-Cookie: sid=set-cookie-canary-R9x2`,
			"glpat-A1b2C3d4E5f6G7h8I9j0-auth: Basic fixture",
			String.raw`C:\Users\Jane Doe. X-Authorization: Negotiate dGVzdC1jYW5hcnk=`,
			String.raw`C:\Users\Jane Doe. X-Cookie: sid=x-cookie-canary-Q3`,
			"-Cookie: color=red; sid=cache-only-canary-X2m8",
			"-Authorization: Basic Zm9vOmJhcg==",
			"-Cookie: {\n-  sid: fixture-opaque-Q8m4\n-}",
			"-Cookie: \n  sid=fixture-opaque-Q8m4",
			"-Cookie: \n-  sid=review33-opaque-session",
			"-Cookie:\u00A0sid=fixture-nbsp-cookie-Q8m4",
			"Cookie:\u00A0\n\tsid=cache-folded-nbsp-canary",
			"Cookie:\u00A0{\n\tsid: cache-nbsp-map-canary\n}",
			'Cookie:\n\u00A0[\n"sid=cache-list-opaque-Q8m4"\n]',
			'+Cookie:\n+ [\n+   "sid=fixture-cookie-Q8m4"\n+ ]',
			'+Cookie:\n+ [\n+  { "EncryptionKey": [\n+"synthetic-opaque-marked-Q8m4"\n+  ] }\n+ ]',
			'Cookie:\n[\n  [\n    "ordinary"\n  ],\n  "opaque-cookie-tail-Q8m4"\n]',
			"Set-Cookie: \r\n  sid=cache-review-folded-38; Secure",
			'Cookie:\n[\n"Cookie: sid=first",\n"sid=fixture-cookie-tail-round39"\n]',
			" {\n-Cookie: theme=light; sid=round40-cookie-canary\n+x\n }",
			'Cookie:\u00A0\r\n [\r\n   "sid=fixture-cookie-Q8m4"\r\n ]',
			"Cookie: \u00A0\nEncryptionKey:\n  synthetic-opaque-Q8m4",
			"-/home/demo-user/config",
			"10. item\n\n    # Release | Notes\n    ---|---\n    https://fixture-user:alpha|beta@example.test/x",
			"left | right\n--- | ---\n# https://fixture-user:cache|canary@example.test/x",
			"left | right\n--- | ---\n# https://docs.example|user@localhost:/home/cache-fixture/config",
			`left | right\n--- | ---\n# https://docs.example|@${os.homedir()}/cache-canary`,
			"//fixture-user@/home/cache-fixture/config\nhttps://fixture-user@/root/config",
			"json \\/\\/fixture-user@\\/home\\/cache-fixture\\/config",
			"https:\\/\\/localhost:\\/root?view=1\nhttps://localhost:/root#top",
			"```text",
			"https://alice:opaque|part@example.test/x",
			"---|---",
			"```",
		].join("\n");
		const url = `https://github.com/${TEST_REPO}/issues/92`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 92,
			includeComments: true,
			payload: issuePayload(92, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 92, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).toContain("json \\/\\/host/x");
		expect(cached?.payload.body).toContain("|//docs.example|'person@example.test'|");
		expect(cached?.payload.body).toContain("https://example.test/x");
		expect(cached?.payload.body).toContain("https://example.test/y");
		expect(cached?.payload.body).toContain("first|second\n---|---\nhttps://docs.example|'person@example.test'");
		expect(cached?.payload.body).toContain("```text\nhttps://example.test/x\n---|---\n```");
		expect(cached?.payload.body).toContain("|https://example.test/z|keep|");
		expect(cached?.payload.body).toContain("|https://docs.example|person@example.test|");
		expect(cached?.payload.body).toContain("    |https://docs.example|person@example.test|");
		expect(cached?.payload.body).toContain("https://example.test/x");
		expect(cached?.payload.body).not.toContain("alice:demo");
		expect(cached?.payload.body).not.toContain("demo|opaque");
		expect(cached?.payload.body).not.toContain("demo|value");
		expect(cached?.payload.body).not.toContain("demo-password");
		expect(cached?.payload.body).not.toContain("other-password");
		expect(cached?.payload.body).not.toContain("sample-pass");
		expect(cached?.payload.body).not.toContain("/home/demo-user");
		expect(cached?.payload.body).not.toContain("alpha|beta");
		expect(cacheFileBytes()).not.toContain("dummy|split");
		expect(cacheFileBytes()).not.toContain("alpha|beta");
		expect(cacheFileBytes()).not.toContain("cache|canary");
		expect(cacheFileBytes()).not.toContain("cache-fixture");
		expect(cacheFileBytes()).not.toContain("'cache-fixture");
		expect(cacheFileBytes()).not.toContain("Jane Doe");
		expect(cacheFileBytes()).not.toContain(os.homedir());
		expect(cached?.payload.body).not.toContain(os.homedir());
		expect(cacheFileBytes()).not.toContain("dGVzdC1maXh0dXJl");
		expect(cacheFileBytes()).not.toContain("persist-cookie-canary");
		expect(cacheFileBytes()).not.toContain("Y2FjaGU6Y2FuYXJ5");
		expect(cacheFileBytes()).not.toContain("6629fae49393a05397450978507c4ef1");
		expect(cacheFileBytes()).not.toContain("MIIQ2FjaGVPbmx5U3ludGhldGljRml4dHVyZQ==");
		expect(cacheFileBytes()).not.toContain("set-cookie-canary");
		expect(cacheFileBytes()).not.toContain("glpat-A1b2C3d4E5f6G7h8I9j0-auth");
		expect(cacheFileBytes()).not.toContain("dGVzdC1jYW5hcnk");
		expect(cacheFileBytes()).not.toContain("x-cookie-canary");
		expect(cacheFileBytes()).not.toContain("cache-only-canary-X2m8");
		expect(cacheFileBytes()).not.toContain("Zm9vOmJhcg==");
		expect(cacheFileBytes()).not.toContain("fixture-opaque-Q8m4");
		expect(cacheFileBytes()).not.toContain("review33-opaque-session");
		expect(cacheFileBytes()).not.toContain("fixture-nbsp-cookie-Q8m4");
		expect(cacheFileBytes()).not.toContain("cache-folded-nbsp-canary");
		expect(cacheFileBytes()).not.toContain("cache-nbsp-map-canary");
		expect(cacheFileBytes()).not.toContain("cache-list-opaque-Q8m4");
		expect(cacheFileBytes()).not.toContain("fixture-cookie-Q8m4");
		expect(cacheFileBytes()).not.toContain("synthetic-opaque-marked-Q8m4");
		expect(cacheFileBytes()).not.toContain("opaque-cookie-tail-Q8m4");
		expect(cacheFileBytes()).not.toContain("cache-review-folded-38");
		expect(cacheFileBytes()).not.toContain("fixture-cookie-tail-round39");
		expect(cacheFileBytes()).not.toContain("round40-cookie-canary");
		expect(cacheFileBytes()).not.toContain("synthetic-opaque-Q8m4");
		expect(cacheFileBytes()).not.toContain("/root/config");
		expect(cacheFileBytes()).not.toContain("/root?view=1");
		expect(cacheFileBytes()).not.toContain("/root#top");
		expect(cached?.payload.body).not.toContain("opaque");
		expect(cached?.payload.body).not.toContain("alice:demo");
	});

	it("redacts an unterminated container through the next diff section", () => {
		const diff = [
			"diff --git a/one b/one",
			"index 1111111..2222222 100644",
			"--- a/one",
			"+++ b/one",
			"@@ -1,5 +1,5 @@",
			" {",
			'-  "items": [',
			'+  "token": [',
			'     "dummy",',
			'     "item2",',
			'     "item3",',
			"diff --git a/next b/next",
			"index 3333333..4444444 100644",
			"--- a/next",
			"+++ b/next",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 94,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain("dummy");
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 94, false, TEST_AUTH_KEY);
		expect(cached?.payload.unified).not.toContain("dummy");
		expect(cached?.payload.unified).toContain("diff --git a/next b/next");
		expect(cached?.payload.files).toHaveLength(2);
		const [first, second] = cached?.payload.files ?? [];
		expect(cached?.payload.unified.slice(first?.startOffset, first?.endOffset)).toContain("«redacted»");
		expect(cached?.payload.unified.slice(second?.startOffset, second?.endOffset)).toContain("+new");
	});

	it("masks an escaped custom home path", () => {
		const escapedHome = os.homedir().replaceAll("/", "\\/");
		const body = `{"path":"${escapedHome}/private.key"}\n{"path":"C:\\\\Users\\\\cache-fixture\\\\config"}\n{"path":"C:\\\\Users\\\\'cache-fixture\\\\config"}\n{"path":"C:\\\\Users\\\\Jane Doe\\\\config"}`;
		const url = `https://github.com/${TEST_REPO}/issues/95`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 95,
			includeComments: true,
			payload: issuePayload(95, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(escapedHome);
		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 95, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).not.toContain(escapedHome);
		expect(cacheFileBytes()).not.toContain("cache-fixture");
	});

	it("keeps a sanitized diff path byte-stable across write and read", () => {
		const secret = "demo-token-1234";
		const diff = [
			`diff --git "a/plain" "b/Authorization: Bearer ${secret}"`,
			"index 1111111..2222222 100644",
			"--- a/plain",
			`+++ "b/Authorization: Bearer ${secret}"`,
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 93,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		const first = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 93, false, TEST_AUTH_KEY);
		const second = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 93, false, TEST_AUTH_KEY);
		expect(first?.payload.unified).toBe(second?.payload.unified);
		expect(first?.payload.unified).not.toContain(secret);
		expect(first?.payload.files).toHaveLength(1);
		expect(first?.payload.files[0]?.path).toBe("Authorization: Bearer «redacted»");
		const [file] = first?.payload.files ?? [];
		expect(first?.payload.unified.slice(file?.startOffset, file?.endOffset).startsWith('diff --git "a/plain"')).toBe(
			true,
		);
		const db = openDb();
		expect(db).not.toBeNull();
		const row = db
			?.prepare(
				"SELECT payload, rendered FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			)
			.get(TEST_AUTH_KEY, TEST_REPO, "pr-diff", 93, 0) as { payload: string; rendered: string } | null;
		expect(row?.rendered).toBe(first?.payload.unified);
		expect((JSON.parse(row?.payload ?? "{}") as { unified?: string }).unified).toBe(first?.payload.unified);
	});

	it("uses copy metadata to resolve an ambiguous diff header", () => {
		const secret = "opaque-cache-value-1234567890";
		const diff = [
			"diff --git a/plain b/f b/x",
			"similarity index 100%",
			"copy from plain",
			`copy to "f b/x/\\164oken=${secret}"`,
			"",
		].join("\n");
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "pr-diff",
			number: 79,
			includeComments: false,
			payload: parsePrUnifiedDiff(diff),
			rendered: diff,
			fetchedAt: 1,
		});

		expect(cacheFileBytes()).not.toContain(secret);
		const cached = getCached<PrDiffPayload>(TEST_REPO, "pr-diff", 79, false, TEST_AUTH_KEY);
		expect(cached?.payload.files[0]?.path).toBe("f b/x/token=«redacted»");
		expect(cached?.payload.files[0]?.oldPath).toBe("plain");
	});

	it("does not merge two compact table cells into one URL", () => {
		const body = [
			"| left | right |",
			"|---|---|",
			"|//example.test|dev@else.test|",
			"|https://docs.example|dev@else.test|",
			"|https://docs.example|'person@example.test'|",
		].join("\n");
		const url = `https://github.com/${TEST_REPO}/issues/78`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 78,
			includeComments: true,
			payload: issuePayload(78, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 78, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).toBe(
			[
				"| left | right |",
				"|---|---|",
				"|//example.test|dev@else.test|",
				"|https://docs.example|dev@else.test|",
				"|https://docs.example|'person@example.test'|",
			].join("\n"),
		);
	});

	it("drops a vendor token glued to an identifier", () => {
		const body = `build_${GITHUB_TOKEN}`;
		const url = `https://github.com/${TEST_REPO}/issues/70`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 70,
			includeComments: true,
			payload: issuePayload(70, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 70, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).not.toContain(GITHUB_TOKEN);
		expect(cached?.payload.body).toContain("build_«redacted-github-token»");
	});

	it("drops an opaque value stored under a credential field", () => {
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 71,
			includeComments: true,
			payload: { access_token: "opaque-cache-demo-0123456789", nested: { token: "another-opaque-demo-value" } },
			rendered: "nested",
			fetchedAt: 1,
		});

		const cached = getCached<{ access_token?: string; nested?: { token?: string } }>(
			TEST_REPO,
			"issue",
			71,
			true,
			TEST_AUTH_KEY,
		);
		expect(cached?.payload.access_token).toBe("«redacted»");
		expect(cached?.payload.nested?.token).toBe("«redacted»");
		expect(cacheFileBytes()).not.toContain("opaque-cache-demo-0123456789");
	});

	it("scrubs a delimited home path and preserves a URL whose path starts with /home/", () => {
		const hostPath = path.join(os.homedir(), "gjc-delimited");
		const body = [
			`| local | \`${hostPath}\` |`,
			"",
			"`" + hostPath + "` and https://docs.example/#/home/public/guide",
			"ipv6 https://[::1]/home/public/guide still a URL",
			"|https://example.test/docs|/home/demo-user/report|",
			"file:///home/demo-user/notes.txt and file://localhost/home/demo-user/notes.txt",
		].join("\n");
		const url = `https://github.com/${TEST_REPO}/issues/72`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 72,
			includeComments: true,
			payload: issuePayload(72, body, url),
			rendered: body,
			sourceUrl: url,
			fetchedAt: 1,
		});

		const cached = getCached<{ body?: string }>(TEST_REPO, "issue", 72, true, TEST_AUTH_KEY);
		expect(cached?.payload.body).not.toContain(hostPath);
		expect(cached?.payload.body).toContain("https://docs.example/#/home/public/guide");
		expect(cached?.payload.body).toContain("https://[::1]/home/public/guide");
		expect(cached?.payload.body).toContain("|https://example.test/docs|~/report|");
		expect(cached?.payload.body).toContain("file:///~/notes.txt");
		expect(cached?.payload.body).toContain("file://localhost/~/notes.txt");
		expect(cached?.payload.body).toContain("| local | `~/gjc-delimited` |");
	});

	it("round-trips ordinary markdown, code, URLs and $HOME-relative examples", async () => {
		const body = [
			"## Steps",
			"",
			"| file | action |",
			"|---|---|",
			"| `src/app.ts` | edit |",
			"| access_token=opaque-demo-value | keep |",
			"",
			"```sh",
			"cd $HOME/src/app",
			"export TOKEN=$HOME/example ; echo ready",
			"EMPTY_TOKEN=",
			"echo after-empty",
			"curl -sS https://api.github.com/repos/o/r",
			"```",
			"",
			"See [docs](https://example.com/guide) and `~/scratch/out.log`.",
		].join("\n");
		const url = `https://github.com/${TEST_REPO}/issues/66`;
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(66, body, url) as never);

		await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "66",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		const again = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "66",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
		});
		expect(again.status).toBe("fresh");
		expect(again.rendered).toContain("| `src/app.ts` | edit |");
		expect(again.rendered).toContain("| access_token=«redacted» | keep |");
		expect(again.rendered).toContain("cd $HOME/src/app");
		expect(again.rendered).toContain("export TOKEN=«redacted» ; echo ready");
		expect(again.rendered).toContain("EMPTY_TOKEN=«redacted»\necho after-empty");
		expect(again.rendered).toContain("https://example.com/guide");
		expect(again.rendered).toContain("`~/scratch/out.log`");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("scrubs a stale cache hit before returning it", async () => {
		const url = `https://github.com/${TEST_REPO}/issues/73`;
		putCached({
			authKey: TEST_AUTH_KEY,
			repo: TEST_REPO,
			kind: "issue",
			number: 73,
			includeComments: true,
			payload: issuePayload(73, `stale ${GITHUB_TOKEN}`, url),
			rendered: `stale ${GITHUB_TOKEN}`,
			sourceUrl: url,
			fetchedAt: 1,
		});
		const settings = {
			get: (key: string) => {
				if (key === "github.cache.softTtlSec") return 1;
				if (key === "github.cache.hardTtlSec") return 10000000000;
				return undefined;
			},
		};
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(73, "refreshed", url) as never);

		const result = await getOrFetchIssue({
			cwd: tempDir,
			repo: TEST_REPO,
			issue: "73",
			includeComments: true,
			cacheAuthKey: TEST_AUTH_KEY,
			settings: settings as never,
		});
		expect(result.status).toBe("stale");
		expect(result.rendered).not.toContain(GITHUB_TOKEN);
		expect((result.payload as { body?: string }).body).not.toContain(GITHUB_TOKEN);
		spy.mockRestore();
	});

	it("property: rewriting a quoted diff path keeps it decodable and indexed", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[a-z0-9]{1,8}$/), segment => {
				const diffPath = `a/${segment}/secret/${segment}`;
				const diff = [
					`diff --git "a/${diffPath}" "b/${diffPath}"`,
					"new file mode 100644",
					"--- /dev/null",
					`+++ "b/${diffPath}"`,
					"@@ -0,0 +1 @@",
					"+content",
					"diff --git a/tail b/tail",
					"index 7777777..8888888 100644",
					"--- a/tail",
					"+++ b/tail",
					"@@ -1 +1 @@",
					"+tail",
					"",
				].join("\n");
				const redacted = (value: string) => value.replaceAll("secret", "«redacted»");
				const rewritten = scrubPrDiffText(diff, redacted);
				expect(rewritten).not.toContain("secret");
				const parsed = parsePrUnifiedDiff(rewritten);
				expect(parsed.files).toHaveLength(2);
				expect(parsed.files[0]?.path).toBe(`a/${segment}/«redacted»/${segment}`);
				const [first, second] = parsed.files;
				expect(rewritten.slice(first?.startOffset, first?.endOffset).startsWith(`diff --git "a/`)).toBe(true);
				expect(rewritten.slice(first?.startOffset, first?.endOffset)).toContain("+content");
				expect(rewritten.slice(second?.startOffset, second?.endOffset)).toBe(
					[
						"diff --git a/tail b/tail",
						"index 7777777..8888888 100644",
						"--- a/tail",
						"+++ b/tail",
						"@@ -1 +1 @@",
						"+tail",
						"",
					].join("\n"),
				);
			}),
			{ seed: 71481023, numRuns: 64 },
		);
	});

	it("property: nested cache values round-trip and omit credentials", () => {
		let rowNumber = 80;
		fc.assert(
			fc.property(
				nestedValue,
				fc.constantFrom("issue" as const, "pr" as const),
				fc.boolean(),
				ordinaryText,
				ordinaryText,
				fc.constantFrom("\n", "\r\n", "\t"),
				credentialText,
				(ordinary, kind, includeComments, rendered, sourceTail, boundary, secret) => {
					const plainNumber = rowNumber++;
					const plainUrl = `https://github.com/${TEST_REPO}/issues/${plainNumber}/${sourceTail}`;
					putCached({
						authKey: TEST_AUTH_KEY,
						repo: TEST_REPO,
						kind,
						number: plainNumber,
						includeComments,
						payload: ordinary,
						rendered,
						sourceUrl: plainUrl,
						fetchedAt: 1,
					});
					const plain = getCached(TEST_REPO, kind, plainNumber, includeComments, TEST_AUTH_KEY);
					expect(plain?.payload).toEqual(ordinary);
					expect(plain?.rendered).toBe(rendered);
					expect(plain?.sourceUrl).toBe(plainUrl);

					const wrapped = `${boundary}${secret}${boundary}`;
					const secretNumber = rowNumber++;
					putCached({
						authKey: TEST_AUTH_KEY,
						repo: TEST_REPO,
						kind,
						number: secretNumber,
						includeComments,
						payload: {
							outer: ordinary,
							level: [{ inner: { text: wrapped, [wrapped]: "kept" } }],
						},
						rendered: `${rendered}${boundary}${secret}`,
						sourceUrl: `https://github.com/${TEST_REPO}/issues/${secretNumber}${boundary}${secret}`,
						fetchedAt: 1,
					});
					const stored = getCached(TEST_REPO, kind, secretNumber, includeComments, TEST_AUTH_KEY);
					expect(stored).not.toBeNull();
					const payload = stored?.payload as {
						outer: JsonValue;
						level: Array<{ inner: { text: string } }>;
					};
					const packed = `${stored?.rendered ?? ""}\n${stored?.sourceUrl ?? ""}\n${JSON.stringify(stored?.payload)}`;
					expect(packed).not.toContain(secret);
					expect(cacheFileBytes()).not.toContain(secret);
					expect(payload.outer).toEqual(ordinary);
					expect(payload.level).toHaveLength(1);
					expect(payload.level[0]?.inner.text).not.toContain(secret);
					expect(Object.values(payload.level[0]?.inner ?? {})).toContain("kept");
				},
			),
			{ seed: 71481023, numRuns: 64 },
		);
	});
});
