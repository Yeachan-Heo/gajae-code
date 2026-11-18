/**
 * Structural gaps that remain at `869b1a553f` (PR #7148 scrub rework, branch
 * `analysis/7148-structural-verdict`). These cases assert the behavior the
 * cache needs; they FAIL on purpose at this head and are committed as evidence
 * for the design verdict, not as a fix.
 *
 * Each case goes through the persistence boundary (`putCached` -> sqlite ->
 * `getCached`) and inspects the raw database bytes, so a read-side re-scrub
 * cannot hide a row that was written leaking.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PrDiffPayload, parsePrUnifiedDiff } from "@gajae-code/coding-agent/tools/gh";
import { getCached, putCached, resetForTests } from "@gajae-code/coding-agent/tools/github-cache";

const TEST_REPO = "owner/example";
const TEST_AUTH_KEY = "verdict";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-verdict-"));
	process.env.GJC_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetForTests();
});

afterEach(async () => {
	resetForTests();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function cacheFileBytes(): string {
	const dbPath = process.env.GJC_GITHUB_CACHE_DB as string;
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

function storeDiff(number: number, diff: string): string {
	putCached({
		authKey: TEST_AUTH_KEY,
		repo: TEST_REPO,
		kind: "pr-diff",
		number,
		includeComments: false,
		payload: parsePrUnifiedDiff(diff),
		rendered: diff,
		fetchedAt: 1,
	});
	return getCached<PrDiffPayload>(TEST_REPO, "pr-diff", number, false, TEST_AUTH_KEY)?.payload.unified ?? "";
}

function storeBody(number: number, body: string): string | undefined {
	putCached({
		authKey: TEST_AUTH_KEY,
		repo: TEST_REPO,
		kind: "issue",
		number,
		includeComments: false,
		payload: { body },
		rendered: body,
		fetchedAt: 1,
	});
	return getCached<{ body?: string }>(TEST_REPO, "issue", number, false, TEST_AUTH_KEY)?.payload.body;
}

const HEADER = ["diff --git a/a b/a", "index 1111111..2222222 100644", "--- a/a", "+++ b/a"];

describe("known structural gaps at 869b1a553f (these fail on purpose)", () => {
	it("GAP 1: a structured JSON credential value crosses diff sides", () => {
		// The JSON credential pass still scans the raw hunk text, so the old-side
		// `],` closes the value and the added item survives. The same pass splices
		// the multiline value into one line, so the hunk loses a physical line.
		const diff = [
			...HEADER,
			"@@ -1,3 +1,3 @@",
			' {"token": [',
			'-  "old"],',
			'+  "mixed-json-canary"],',
			'  "keep": 1}',
			"",
		].join("\n");
		const unified = storeDiff(1701, diff);
		expect(unified).not.toContain("mixed-json-canary");
		expect(cacheFileBytes()).not.toContain("mixed-json-canary");
		expect(unified.split("\n")).toHaveLength(diff.split("\n").length);
	});

	it("GAP 2: a header whose value starts on a later line loses its framing", () => {
		// The diff write-back only protects a header line when the same line holds
		// value coverage. `Cookie:` alone keeps a raw header, and the later shared
		// folded-cookie rule consumes the newline and the next `+ ` prefix.
		const diff = [...HEADER, "@@ -0,0 +1,4 @@", "+Cookie:", "+ [", '+  "header-fold-canary"', "+]", ""].join("\n");
		const unified = storeDiff(1702, diff);
		expect(unified).not.toContain("header-fold-canary");
		expect(unified.split("\n")).toHaveLength(diff.split("\n").length);
		expect(unified.split("\n")).toContain("+ [");
	});

	it("GAP 3: a container opened in one hunk is not carried into the next hunk", () => {
		// The required design resets state at hunk boundaries, so items that belong
		// to a container opened in an earlier hunk of the same file are persisted.
		// Closing this requires side-aware file context, not a per-hunk scanner.
		const diff = [
			...HEADER,
			"@@ -1,1 +1,1 @@",
			"-Auth: [",
			"+Auth: [",
			"@@ -40,1 +40,1 @@",
			'-  "hunk-one-canary"',
			'+  "hunk-two-canary"',
			"",
		].join("\n");
		const unified = storeDiff(1703, diff);
		expect(unified).not.toContain("hunk-one-canary");
		expect(unified).not.toContain("hunk-two-canary");
		expect(cacheFileBytes()).not.toContain("hunk-one-canary");
		expect(cacheFileBytes()).not.toContain("hunk-two-canary");
	});
});

describe("positive controls the scrub must still allow", () => {
	it("round-trips a legitimate escaped JSON array byte for byte", () => {
		const body = 'payload: {\\"name\\": [\\"a]b\\"], \\"keep\\": 1}';
		expect(storeBody(1711, body)).toBe(body);
	});

	it("round-trips a legitimate diff with plain brackets byte for byte", () => {
		const diff = [...HEADER, "@@ -1,2 +1,2 @@", " [1, 2, 3]", " keep]", "+ add]", ""].join("\n");
		expect(storeDiff(1712, diff)).toBe(diff);
	});

	it("still redacts a plain single-line Cookie header", () => {
		expect(storeBody(1713, "Cookie: sid=plain-cookie-secret; theme=dark")).toBe("Cookie: «redacted»");
	});
});
