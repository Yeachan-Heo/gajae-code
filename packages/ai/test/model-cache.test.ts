import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeModelCache,
	insertModelCacheIfAbsent,
	publishModelCacheIfNotUpdatedAfter,
	readModelCache,
	updateModelCacheIfUnchanged,
	writeModelCache,
} from "../src/model-cache";
import type { Model } from "../src/types";

const TTL_MS = 24 * 60 * 60 * 1000;

function createModel(id: string, name: string): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

describe("model cache migrations", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(() => {
		closeModelCache(dbPath);
	});
	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
			dbPath = "";
		}
	});

	it("preserves v2 cached models and lets the next discovery overwrite them", () => {
		const legacyModel = createModel("legacy-cloud-model", "Legacy Cloud Model");
		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		legacyDb.run(
			"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, models) VALUES (?, ?, ?, ?, ?)",
			["ollama-cloud", 2, Date.now(), 1, JSON.stringify([legacyModel])],
		);
		legacyDb.close();

		const migrated = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(migrated?.models.map(model => model.id)).toEqual(["legacy-cloud-model"]);
		expect(migrated?.staticFingerprint).toBe("");

		const replacementModel = createModel("fresh-cloud-model", "Fresh Cloud Model");
		writeModelCache("ollama-cloud", Date.now(), [replacementModel], true, "static-v3", dbPath);

		const overwritten = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(overwritten?.models.map(model => model.id)).toEqual(["fresh-cloud-model"]);
		expect(overwritten?.staticFingerprint).toBe("static-v3");
	});

	it("preserves a v4 row with authoritative dynamic IDs and provenance", () => {
		const legacyModel = createModel("dynamic-cloud-model", "Dynamic Cloud Model");
		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				static_fingerprint TEXT NOT NULL DEFAULT '',
				dynamic_model_ids TEXT,
				dynamic_model_provenance TEXT,
				models TEXT NOT NULL
			)
		`);
		legacyDb.run(
			`INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, dynamic_model_ids, dynamic_model_provenance, models)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"ollama-cloud",
				4,
				Date.now(),
				1,
				"static-v4",
				JSON.stringify([legacyModel.id]),
				"provenance-v4",
				JSON.stringify([legacyModel]),
			],
		);
		legacyDb.close();

		const migrated = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(migrated?.models.map(model => model.id)).toEqual(["dynamic-cloud-model"]);
		expect(migrated?.dynamicModelIds).toEqual(["dynamic-cloud-model"]);
		expect(migrated?.dynamicModelProvenance).toBe("provenance-v4");
	});

	it("does not conditionally replace a row changed after it was observed", () => {
		const observedAt = 1_700_000_000_000;
		const replacementAt = observedAt + 1;
		writeModelCache(
			"ollama-cloud",
			observedAt,
			[createModel("dynamic-a", "Dynamic A")],
			true,
			"static",
			dbPath,
			["dynamic-a"],
			"provenance-a",
		);
		writeModelCache(
			"ollama-cloud",
			replacementAt,
			[createModel("dynamic-b", "Dynamic B")],
			true,
			"static",
			dbPath,
			["dynamic-b"],
			"provenance-b",
		);

		const updated = updateModelCacheIfUnchanged(
			"ollama-cloud",
			observedAt,
			["dynamic-a"],
			"provenance-a",
			[createModel("dynamic-a", "Dynamic A")],
			observedAt + 2,
			[createModel("fallback-a", "Fallback A")],
			false,
			"static",
			dbPath,
		);

		expect(updated).toBe(false);
		expect(readModelCache("ollama-cloud", TTL_MS, () => replacementAt, dbPath)).toMatchObject({
			authoritative: true,
			updatedAt: replacementAt,
			dynamicModelIds: ["dynamic-b"],
			dynamicModelProvenance: "provenance-b",
		});
	});

	it("does not conditionally replace same-tuple content changed after observation", () => {
		const observedAt = 1_700_000_000_000;
		const ids = ["dynamic-a"];
		writeModelCache(
			"ollama-cloud",
			observedAt,
			[createModel("dynamic-a", "Observed A")],
			true,
			"static",
			dbPath,
			ids,
			"provenance-a",
		);
		const observed = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, () => observedAt, dbPath);
		writeModelCache(
			"ollama-cloud",
			observedAt,
			[createModel("dynamic-a", "Concurrent B")],
			true,
			"static",
			dbPath,
			ids,
			"provenance-a",
		);

		const updated = updateModelCacheIfUnchanged(
			"ollama-cloud",
			observedAt,
			ids,
			"provenance-a",
			observed?.models ?? [],
			observedAt + 1,
			[createModel("dynamic-a", "Failed Fetch")],
			false,
			"static",
			dbPath,
		);

		expect(updated).toBe(false);
		expect(
			readModelCache<"openai-completions">("ollama-cloud", TTL_MS, () => observedAt, dbPath)?.models[0]?.name,
		).toBe("Concurrent B");
	});

	it("rejects a late publication after a newer row is published", () => {
		const discoveryStartedAt = 1_700_000_000_000;
		const newerPublicationAt = discoveryStartedAt + 1;
		writeModelCache(
			"ollama-cloud",
			discoveryStartedAt - 1,
			[createModel("dynamic-old", "Dynamic Old")],
			true,
			"static",
			dbPath,
			["dynamic-old"],
			"provenance-old",
		);
		writeModelCache(
			"ollama-cloud",
			newerPublicationAt,
			[createModel("dynamic-new", "Dynamic New")],
			true,
			"static",
			dbPath,
			["dynamic-new"],
			"provenance-new",
		);

		const published = publishModelCacheIfNotUpdatedAfter(
			"ollama-cloud",
			discoveryStartedAt,
			discoveryStartedAt + 2,
			[createModel("dynamic-old", "Dynamic Old")],
			true,
			"static",
			dbPath,
			["dynamic-old"],
			"provenance-old",
		);

		expect(published).toBe(false);
		expect(readModelCache("ollama-cloud", TTL_MS, () => newerPublicationAt, dbPath)).toMatchObject({
			authoritative: true,
			updatedAt: newerPublicationAt,
			dynamicModelIds: ["dynamic-new"],
			dynamicModelProvenance: "provenance-new",
			models: [expect.objectContaining({ id: "dynamic-new" })],
		});
	});

	it("inserts a cache row only when the provider is absent", () => {
		const insertedAt = 1_700_000_000_000;
		const tombstone = createModel("tombstone", "Tombstone");
		const writer = createModel("writer", "Writer");

		expect(insertModelCacheIfAbsent("ollama-cloud", insertedAt, [tombstone], false, "static-tombstone", dbPath)).toBe(
			true,
		);
		expect(readModelCache<"openai-completions">("ollama-cloud", TTL_MS, () => insertedAt, dbPath)).toMatchObject({
			authoritative: false,
			updatedAt: insertedAt,
			staticFingerprint: "static-tombstone",
			models: [expect.objectContaining({ id: "tombstone" })],
		});

		writeModelCache(
			"ollama-cloud",
			insertedAt + 1,
			[writer],
			true,
			"static-writer",
			dbPath,
			["writer"],
			"provenance-w",
		);
		expect(
			insertModelCacheIfAbsent("ollama-cloud", insertedAt + 2, [tombstone], false, "static-tombstone", dbPath),
		).toBe(false);
		expect(readModelCache<"openai-completions">("ollama-cloud", TTL_MS, () => insertedAt + 1, dbPath)).toMatchObject({
			authoritative: true,
			updatedAt: insertedAt + 1,
			staticFingerprint: "static-writer",
			dynamicModelIds: ["writer"],
			dynamicModelProvenance: "provenance-w",
			models: [expect.objectContaining({ id: "writer" })],
		});
	});

	it("closes only the exact shared database owner before root removal", async () => {
		writeModelCache("ollama-cloud", Date.now(), [createModel("owned", "Owned")], true, "static", dbPath);
		expect(closeModelCache(path.join(tempDir, "other.db"))).toBe(false);
		expect(closeModelCache(dbPath)).toBe(true);
		expect(closeModelCache(dbPath)).toBe(false);
		await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
		dbPath = "";
	});
});
