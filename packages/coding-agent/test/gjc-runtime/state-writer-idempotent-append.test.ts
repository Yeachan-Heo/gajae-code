import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendJsonlIdempotent } from "@gajae-code/coding-agent/gjc-runtime/state-writer";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-idempotent-append-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function readLines(filePath: string): Promise<unknown[]> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch {
		return [];
	}
	return raw
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.flatMap(line => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

const byId = (entry: unknown): string | undefined => {
	if (!entry || typeof entry !== "object") return undefined;
	const id = (entry as Record<string, unknown>).id;
	return typeof id === "string" ? id : undefined;
};

describe("appendJsonlIdempotent (issue #660)", () => {
	it("appends a fresh entry and reports appended: true", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";

		const result = await appendJsonlIdempotent(target, { id: "a", note: "first" }, { cwd: root, key: byId });

		expect(result.appended).toBe(true);
		expect(result.duplicate).toBeUndefined();
		const lines = await readLines(result.path);
		expect(lines).toEqual([{ id: "a", note: "first" }]);
	});

	it("skips a duplicate key, leaving the original row untouched", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";

		await appendJsonlIdempotent(target, { id: "a", note: "first" }, { cwd: root, key: byId });
		// Same identity key, different payload: the append must collapse and the
		// pre-existing row (not the new payload) must survive.
		const second = await appendJsonlIdempotent(target, { id: "a", note: "second" }, { cwd: root, key: byId });

		expect(second.appended).toBe(false);
		expect(second.duplicate).toEqual({ id: "a", note: "first" });
		const lines = await readLines(second.path);
		expect(lines).toEqual([{ id: "a", note: "first" }]);
	});

	it("appends entries with distinct keys", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";

		await appendJsonlIdempotent(target, { id: "a" }, { cwd: root, key: byId });
		const second = await appendJsonlIdempotent(target, { id: "b" }, { cwd: root, key: byId });

		expect(second.appended).toBe(true);
		const lines = await readLines(second.path);
		expect(lines).toEqual([{ id: "a" }, { id: "b" }]);
	});

	it("always appends entries whose key is undefined (dedup opt-out)", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";

		// `byId` returns undefined for these rows, so dedup must not engage.
		await appendJsonlIdempotent(target, { kind: "anon" }, { cwd: root, key: byId });
		const second = await appendJsonlIdempotent(target, { kind: "anon" }, { cwd: root, key: byId });

		expect(second.appended).toBe(true);
		const lines = await readLines(second.path);
		expect(lines).toHaveLength(2);
	});

	it("uses the equals predicate when provided", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";
		const equals = (candidate: unknown, existing: unknown): boolean =>
			(candidate as { tag?: string }).tag === (existing as { tag?: string }).tag;

		await appendJsonlIdempotent(target, { tag: "x", seq: 1 }, { cwd: root, equals });
		const second = await appendJsonlIdempotent(target, { tag: "x", seq: 2 }, { cwd: root, equals });

		expect(second.appended).toBe(false);
		expect(second.duplicate).toEqual({ tag: "x", seq: 1 });
		const lines = await readLines(second.path);
		expect(lines).toEqual([{ tag: "x", seq: 1 }]);
	});

	it("prefers equals over key when both are supplied", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";
		// key would treat these as distinct, but equals always matches → dedup.
		const equals = (): boolean => true;

		await appendJsonlIdempotent(target, { id: "a" }, { cwd: root, key: byId, equals });
		const second = await appendJsonlIdempotent(target, { id: "b" }, { cwd: root, key: byId, equals });

		expect(second.appended).toBe(false);
		const lines = await readLines(second.path);
		expect(lines).toEqual([{ id: "a" }]);
	});

	it("throws when neither key nor equals is supplied", async () => {
		const root = await tempDir();
		await expect(
			appendJsonlIdempotent(".gjc/ledger/index.jsonl", { id: "a" }, { cwd: root } as never),
		).rejects.toThrow(/requires a `key` or `equals`/);
	});

	it("ignores corrupt lines when checking for duplicates (best-effort)", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";
		const filePath = path.join(root, target);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "{ not json\n", "utf-8");

		// A corrupt row cannot be matched, so the new append must still go through.
		const result = await appendJsonlIdempotent(target, { id: "a" }, { cwd: root, key: byId });
		expect(result.appended).toBe(true);

		// And a subsequent identical append still dedups against the parseable row.
		const second = await appendJsonlIdempotent(target, { id: "a" }, { cwd: root, key: byId });
		expect(second.appended).toBe(false);

		const lines = await readLines(filePath);
		expect(lines).toEqual([{ id: "a" }]);
	});

	it("serializes concurrent idempotent appends so a duplicate is written once (TOCTOU)", async () => {
		const root = await tempDir();
		const target = ".gjc/ledger/index.jsonl";

		// Without the cross-process lock, every racing append reads "no duplicate"
		// and all of them write — the issue #646 TOCTOU. The shared primitive must
		// serialize the read-check-append so exactly one row survives.
		const results = await Promise.all(
			Array.from({ length: 12 }, () => appendJsonlIdempotent(target, { id: "race" }, { cwd: root, key: byId })),
		);

		const appended = results.filter(result => result.appended);
		expect(appended).toHaveLength(1);
		const lines = await readLines(path.join(root, target));
		expect(lines).toEqual([{ id: "race" }]);
	});
});
