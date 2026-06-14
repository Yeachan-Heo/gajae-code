import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "../src/session/history-storage";

let tempDir = "";

async function freshStorage(): Promise<HistoryStorage> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-history-search-"));
	HistoryStorage.resetInstance();
	return HistoryStorage.open(path.join(tempDir, "history.db"));
}

async function seed(storage: HistoryStorage, prompts: string[]): Promise<void> {
	const writes = prompts.map(prompt => storage.add(prompt, "/tmp/test"));
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.resetInstance();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.resetInstance();
	vi.useRealTimers();
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("HistoryStorage.search", () => {
	it("matches across punctuation in the query (FTS token alignment)", async () => {
		const storage = await freshStorage();
		await seed(storage, ["run git commit --amend now", "unrelated noise"]);

		// Before the tokenization fix, `git-commit` produced a single FTS phrase
		// `"git-commit"*` which matched nothing because unicode61 indexed the stored
		// prompt as `git` and `commit` separately.
		const results = storage.search("git-commit", 10);
		expect(results.map(r => r.prompt)).toEqual(["run git commit --amend now"]);
	});

	it("falls back to substring matching for infix queries FTS prefix cannot reach", async () => {
		const storage = await freshStorage();
		await seed(storage, ["run git commit later", "totally unrelated text"]);

		// FTS5 `*` is prefix-only — `mit` cannot match `commit` via FTS.
		// Substring fallback must catch it.
		const results = storage.search("mit", 10);
		expect(results.map(r => r.prompt)).toEqual(["run git commit later"]);
	});

	it("AND's substring tokens so multi-word infix queries narrow results", async () => {
		const storage = await freshStorage();
		await seed(storage, [
			"commit and amend the patch",
			"commit only without the other",
			"amend only without the other",
		]);

		// Each token must appear (as substring). `mit` is infix of `commit`, so FTS
		// returns nothing; substring fallback must AND both tokens.
		const results = storage.search("mit amend", 10);
		expect(results.map(r => r.prompt)).toEqual(["commit and amend the patch"]);
	});

	it("returns FTS matches before substring-only fallback matches", async () => {
		const storage = await freshStorage();
		// Insert oldest -> newest. Substring-only match is the most recent;
		// FTS prefix match is older. FTS results must still come first.
		await seed(storage, ["commit the changes", "precommit hook fix"]);

		const results = storage.search("commit", 10);
		expect(results.map(r => r.prompt)).toEqual([
			"commit the changes", // FTS prefix match on token `commit`
			"precommit hook fix", // substring-only (`commit` is infix of `precommit`)
		]);
	});

	it("dedupes when FTS and substring both match the same row", async () => {
		const storage = await freshStorage();
		await seed(storage, ["commit the changes"]);

		const results = storage.search("commit", 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.prompt).toBe("commit the changes");
	});

	it("matches case-insensitively for substring fallback", async () => {
		const storage = await freshStorage();
		await seed(storage, ["Recommit The Patch"]);

		const results = storage.search("MIT", 10);
		expect(results.map(r => r.prompt)).toEqual(["Recommit The Patch"]);
	});

	it("returns empty for queries with no alphanumeric characters", async () => {
		const storage = await freshStorage();
		await seed(storage, ["whatever"]);

		expect(storage.search("---", 10)).toEqual([]);
		expect(storage.search("  ", 10)).toEqual([]);
	});

	it("respects the limit when merging FTS and substring results", async () => {
		const storage = await freshStorage();
		await seed(storage, ["commit one", "commit two", "precommit three", "precommit four"]);

		const results = storage.search("commit", 2);
		expect(results).toHaveLength(2);
		// Both FTS matches should fill the limit before substring fallback runs.
		expect(results.map(r => r.prompt)).toEqual(["commit two", "commit one"]);
	});

	it("matches short tokens via the substring fallback", async () => {
		const storage = await freshStorage();
		await seed(storage, ["go run main", "node script"]);

		// Defends short-query (<= 2 char) matching end-to-end.
		const results = storage.search("go", 10);
		expect(results.map(r => r.prompt)).toEqual(["go run main"]);
	});

	it("AND's tokens correctly when one is short and one is an infix", async () => {
		const storage = await freshStorage();
		await seed(storage, ["go commit changes", "go run main", "commit changes"]);

		// `go` matches via FTS, `mit` only matches via substring (infix of commit).
		// Combined: only `go commit changes` satisfies both as substrings.
		const results = storage.search("go mit", 10);
		expect(results.map(r => r.prompt)).toEqual(["go commit changes"]);
	});
});

describe("HistoryStorage cwd filtering", () => {
	async function seedWithCwd(storage: HistoryStorage, rows: Array<[string, string]>): Promise<void> {
		const writes = rows.map(([prompt, cwd]) => storage.add(prompt, cwd));
		vi.advanceTimersByTime(100);
		await Promise.all(writes);
	}

	it("getRecent scoped to a cwd returns only that project's prompts", async () => {
		const storage = await freshStorage();
		await seedWithCwd(storage, [
			["alpha task", "/proj/a"],
			["beta task", "/proj/b"],
			["gamma task", "/proj/a"],
		]);

		expect(storage.getRecent(10, "/proj/a").map(r => r.prompt)).toEqual(["gamma task", "alpha task"]);
		expect(storage.getRecent(10).map(r => r.prompt)).toEqual(["gamma task", "beta task", "alpha task"]);
	});

	it("search scoped to a cwd excludes other projects via FTS and substring paths", async () => {
		const storage = await freshStorage();
		await seedWithCwd(storage, [
			["run git commit now", "/proj/a"],
			["git commit later please", "/proj/b"],
		]);

		// FTS prefix path
		expect(storage.search("commit", 10, "/proj/a").map(r => r.prompt)).toEqual(["run git commit now"]);
		// substring fallback path (infix `mit` of `commit`)
		expect(storage.search("mit", 10, "/proj/a").map(r => r.prompt)).toEqual(["run git commit now"]);
		// unscoped search still spans every project
		expect(storage.search("commit", 10).length).toBe(2);
	});
});
