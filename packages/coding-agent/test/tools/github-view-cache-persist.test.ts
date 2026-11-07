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
import { getOrFetchIssue, getOrFetchPrDiff } from "@gajae-code/coding-agent/tools/gh";
import { getCached, putCached, resetForTests as resetCacheForTests } from "@gajae-code/coding-agent/tools/github-cache";
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
