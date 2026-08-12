import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import type { Model, ToolChoice, ToolChoiceSupport } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	configureToolChoiceCapabilityCacheForTests,
	deriveToolChoiceSupport,
	getToolChoiceCapabilityOverride,
	isCodexStatuslessNamedToolChoiceNotFoundError,
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
	toolChoiceRegistryKey,
} from "../src/utils/tool-choice-capability";

function model(support?: ToolChoiceSupport): Model<"openai-completions"> {
	return {
		id: "local-id",
		name: "Local",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		wireModelId: "wire-id",
		compat: support ? { toolChoiceSupport: support } : undefined,
	};
}

function statusError(status: number, message: string): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

beforeEach(() => {
	configureToolChoiceCapabilityCacheForTests();
	clearToolChoiceIncapabilityRegistryForTests();
});

describe("deriveToolChoiceSupport", () => {
	it("uses explicit support before legacy flags", () => {
		expect(
			deriveToolChoiceSupport({
				toolChoiceSupport: "required",
				supportsToolChoice: false,
				supportsForcedToolChoice: false,
			}),
		).toEqual({ support: "required", source: "static" });
	});

	it("derives none when supportsToolChoice is false", () => {
		expect(deriveToolChoiceSupport({ supportsToolChoice: false })).toEqual({ support: "none", source: "derived" });
	});

	it("derives auto when forced tool choice is false", () => {
		expect(deriveToolChoiceSupport({ supportsForcedToolChoice: false })).toEqual({
			support: "auto",
			source: "derived",
		});
	});

	it("defaults to named", () => {
		expect(deriveToolChoiceSupport(undefined)).toEqual({ support: "named", source: "derived" });
	});
});

describe("resolveToolChoice", () => {
	const requestedChoices: {
		label: string;
		choice: ToolChoice | undefined;
		level: ToolChoiceSupport;
		targetToolName?: string;
	}[] = [
		{ label: "undefined", choice: undefined, level: "auto" },
		{ label: "none", choice: "none", level: "none" },
		{ label: "auto", choice: "auto", level: "auto" },
		{ label: "any", choice: "any", level: "required" },
		{ label: "required", choice: "required", level: "required" },
		{ label: "named", choice: { type: "function", name: "read" }, level: "named", targetToolName: "read" },
	];
	const supports: ToolChoiceSupport[] = ["none", "auto", "required", "named"];
	const rank: Record<ToolChoiceSupport, number> = { none: 0, auto: 1, required: 2, named: 3 };

	for (const support of supports) {
		for (const requested of requestedChoices) {
			it(`clamps ${requested.label} with ${support} support`, () => {
				const result = resolveToolChoice(model(support), requested.choice);
				expect(result.requestedChoice).toEqual(requested.choice);
				expect(result.requestedLevel).toBe(requested.level);
				expect(result.support).toBe(support);
				expect(result.supportSource).toBe("static");
				expect(result.targetToolName).toBe(requested.targetToolName);

				if (requested.choice === undefined) {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("auto");
					expect(result.degraded).toBe(false);
					return;
				}

				if (support === "none") {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("none");
					expect(result.degraded).toBe(requested.level !== "none");
					return;
				}

				const clampLevel = requested.level === "none" ? "auto" : requested.level;
				if (rank[support] >= rank[clampLevel]) {
					expect(result.resolvedChoice).toEqual(requested.choice);
					expect(result.resolvedLevel).toBe(requested.level);
					expect(result.degraded).toBe(false);
				} else if (requested.level === "named" && support === "required") {
					expect(result.resolvedChoice).toBe("required");
					expect(result.resolvedLevel).toBe("required");
					expect(result.degraded).toBe(true);
				} else {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("auto");
					expect(result.degraded).toBe(true);
				}
			});
		}
	}
});

describe("tool-choice registry", () => {
	it("lowers but never raises capability overrides", () => {
		const target = model("named");
		markToolChoiceIncapability(target, "required", "first");
		expect(getToolChoiceCapabilityOverride(target)).toBe("required");
		markToolChoiceIncapability(target, "named", "raise ignored");
		expect(getToolChoiceCapabilityOverride(target)).toBe("required");
		markToolChoiceIncapability(target, "auto", "lowered");
		expect(getToolChoiceCapabilityOverride(target)).toBe("auto");
	});

	it("resets overrides", () => {
		const target = model("named");
		markToolChoiceIncapability(target, "auto");
		clearToolChoiceIncapabilityRegistryForTests();
		expect(getToolChoiceCapabilityOverride(target)).toBeUndefined();
	});

	it("uses runtime overrides only when they lower static support", () => {
		const target = model("required");
		markToolChoiceIncapability(target, "named");
		expect(resolveToolChoice(target, { type: "function", name: "read" }).support).toBe("required");
		expect(resolveToolChoice(target, { type: "function", name: "read" }).supportSource).toBe("static");
		markToolChoiceIncapability(target, "auto");
		const result = resolveToolChoice(target, "required");
		expect(result.support).toBe("auto");
		expect(result.supportSource).toBe("runtime");
		expect(result.resolvedChoice).toBeUndefined();
	});

	it("keys by api provider baseUrl and wire model", () => {
		expect(toolChoiceRegistryKey(model("named"))).toBe(
			"openai-completions|openai|https://api.openai.example/v1|wire-id",
		);
	});
});

describe("durable tool-choice capability cache", () => {
	it("hydrates a learned incapability across simulated fresh processes", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		markToolChoiceIncapability(model("named"), "auto", "secret raw provider error");

		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		const resolved = resolveToolChoice(model("named"), { type: "function", name: "todo_write" });
		expect(resolved.support).toBe("auto");
		expect(resolved.resolvedChoice).toBeUndefined();
		expect(resolved.supportSource).toBe("runtime");
	});

	it("memoizes an empty durable lookup without hiding later revalidation", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-empty-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		let now = 1_000;
		let opens = 0;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now, onCacheOpen: () => opens++ });
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		expect(opens).toBe(1);

		now += 5 * 60 * 1000;
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		expect(opens).toBe(2);
	});

	it("bounds empty lookup memoization", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-empty-bound-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		let opens = 0;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, onCacheOpen: () => opens++ });
		for (let index = 0; index < 300; index++) {
			resolveToolChoice({ ...model("named"), wireModelId: `wire-${index}` }, "required");
		}
		expect(opens).toBe(300);

		resolveToolChoice({ ...model("named"), wireModelId: "wire-0" }, "required");
		expect(opens).toBe(301);
		resolveToolChoice({ ...model("named"), wireModelId: "wire-299" }, "required");
		expect(opens).toBe(301);
	});

	it("expires learned support so provider behavior is re-probed", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-ttl-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		let now = 1_000;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		markToolChoiceIncapability(model("named"), "auto");

		now += 30 * 24 * 60 * 60 * 1000;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
	});

	it("revalidates expiry inside a long-lived process", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-live-ttl-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		let now = 1_000;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		markToolChoiceIncapability(model("named"), "auto");
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");

		now += 30 * 24 * 60 * 60 * 1000;
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
	});

	it("does not delete a capability refreshed while an expired row is being revalidated", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-expiry-race-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		let now = 1_000;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		markToolChoiceIncapability(model("named"), "auto");

		now += 30 * 24 * 60 * 60 * 1000;
		configureToolChoiceCapabilityCacheForTests({
			path: cachePath,
			now: () => now,
			beforeExpiredDelete: () => {
				const database = new Database(cachePath);
				try {
					database.run("UPDATE tool_choice_capabilities SET observed_at = ? WHERE max_support = ?", [now, "auto"]);
				} finally {
					database.close();
				}
			},
		});
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");

		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
	});

	it("refreshes durable and in-memory expiry when the same incapability is observed again", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-refresh-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		let now = 1_000;
		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		markToolChoiceIncapability(model("named"), "auto");

		now += 29 * 24 * 60 * 60 * 1000;
		markToolChoiceIncapability(model("named"), "auto");
		now += 2 * 24 * 60 * 60 * 1000;
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");

		configureToolChoiceCapabilityCacheForTests({ path: cachePath, now: () => now });
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
	});

	it("recovers from a corrupted cache without changing fallback behavior", async () => {
		using tempDir = TempDir.createSync("tool-choice-capability-corrupt-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		await fs.writeFile(cachePath, "not a sqlite database");
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });

		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		markToolChoiceIncapability(model("named"), "auto");
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
	});

	it("recovers from an invalid version-zero schema", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-schema-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		const database = new Database(cachePath);
		try {
			database.run("CREATE TABLE tool_choice_capabilities (wrong TEXT)");
		} finally {
			database.close();
		}
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });

		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		markToolChoiceIncapability(model("named"), "auto");
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
	});

	it("does not delete a row repaired while malformed data is being cleaned", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-malformed-race-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		markToolChoiceIncapability(model("named"), "auto");
		const database = new Database(cachePath);
		try {
			database.run("UPDATE tool_choice_capabilities SET support_rank = 3");
		} finally {
			database.close();
		}

		configureToolChoiceCapabilityCacheForTests({
			path: cachePath,
			beforeMalformedDelete: () => {
				const repair = new Database(cachePath);
				try {
					repair.run("UPDATE tool_choice_capabilities SET support_rank = 1");
				} finally {
					repair.close();
				}
			},
		});
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");

		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
	});

	it("isolates api, provider, base URL, and wire model without persisting raw keys or errors", async () => {
		using tempDir = TempDir.createSync("tool-choice-capability-isolation-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		const target = model("named");
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		markToolChoiceIncapability(target, "auto", "credential=super-secret raw-error-body");

		for (const isolated of [
			{ ...target, api: "openai-responses" as const },
			{ ...target, provider: "other-provider" },
			{ ...target, baseUrl: "https://other.example/v1" },
			{ ...target, wireModelId: "other-wire-id" },
		]) {
			expect(resolveToolChoice(isolated, "required").support).toBe("named");
		}

		const bytes = await fs.readFile(cachePath);
		expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o600);
		const persisted = bytes.toString("utf8");
		expect(persisted).not.toContain(target.baseUrl);
		expect(persisted).not.toContain(target.provider);
		expect(persisted).not.toContain(target.wireModelId ?? "");
		expect(persisted).not.toContain("super-secret");
		expect(persisted).not.toContain("raw-error-body");
	});

	it("serializes concurrent process writes and preserves the lowest support", async () => {
		using tempDir = TempDir.createSync("tool-choice-capability-concurrent-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		const script = `
			import { configureToolChoiceCapabilityCacheForTests, markToolChoiceIncapability } from ${JSON.stringify(
				path.resolve(import.meta.dir, "../src/utils/tool-choice-capability.ts"),
			)};
			const model = ${JSON.stringify(model("named"))};
			configureToolChoiceCapabilityCacheForTests({ path: process.argv[1] });
			markToolChoiceIncapability(model, process.argv[2]);
		`;
		const processes = ["required", "auto", "required", "auto"].map(support =>
			Bun.spawn([process.execPath, "-e", script, cachePath, support], { stdout: "pipe", stderr: "pipe" }),
		);
		const exits = await Promise.all(processes.map(process => process.exited));
		expect(exits).toEqual([0, 0, 0, 0]);

		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
		const database = new Database(cachePath, { readonly: true });
		try {
			expect(database.query("SELECT COUNT(*) AS count FROM tool_choice_capabilities").get()).toEqual({ count: 1 });
		} finally {
			database.close();
		}
	});

	it("does not retire the cache when a transient SQLITE_ERROR occurs during operation", () => {
		using tempDir = TempDir.createSync("tool-choice-capability-transient-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		markToolChoiceIncapability(model("named"), "auto");

		expect(fsSync.existsSync(cachePath)).toBe(true);

		// A generic SQLITE_ERROR (e.g. from a future binding or driver edge case)
		// must not be treated as corruption and must not delete the cache.
		let injected = false;
		configureToolChoiceCapabilityCacheForTests({
			path: cachePath,
			simulateOperationError: () => {
				if (injected) return undefined;
				injected = true;
				return Object.assign(new Error("simulated transient SQLITE_ERROR"), { code: "SQLITE_ERROR" });
			},
		});
		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		expect(fsSync.existsSync(cachePath)).toBe(true);

		// After the transient error, the cache is intact and data is still hydrated.
		configureToolChoiceCapabilityCacheForTests({ path: cachePath });
		expect(resolveToolChoice(model("named"), "required").support).toBe("auto");
	});

	it("does not delete a concurrently recreated valid cache during corruption retirement", async () => {
		using tempDir = TempDir.createSync("tool-choice-capability-recreate-race-");
		const cachePath = path.join(tempDir.path(), "capabilities.db");
		await fs.writeFile(cachePath, "not a sqlite database");

		// Race scenario:
		// 1. withCapabilityCache stats the corrupt file → captures its byte size
		// 2. openCapabilityCache opens the corrupt file → fails with SQLITE_NOTADB
		// 3. beforeCorruptRetire replaces the file with a valid DB (concurrent recreation)
		// 4. retireCorruptCapabilityCache size-checks: size differs → skips deletion
		configureToolChoiceCapabilityCacheForTests({
			path: cachePath,
			beforeCorruptRetire: () => {
				fsSync.rmSync(cachePath, { force: true });
				const replacement = new Database(cachePath, { create: true });
				replacement.run(`
					CREATE TABLE IF NOT EXISTS tool_choice_capabilities (
						key_digest TEXT PRIMARY KEY NOT NULL,
						max_support TEXT NOT NULL,
						support_rank INTEGER NOT NULL,
						observed_at INTEGER NOT NULL
					) STRICT
				`);
				replacement.run("INSERT INTO tool_choice_capabilities VALUES ('test', 'auto', 1, 1000)");
				replacement.run("PRAGMA user_version = 1");
				replacement.close();
			},
		});

		expect(resolveToolChoice(model("named"), "required").support).toBe("named");
		// The valid replacement must survive — identity check prevented deletion.
		expect(fsSync.existsSync(cachePath)).toBe(true);
		const replacement = new Database(cachePath, { readonly: true });
		try {
			expect(replacement.query("SELECT COUNT(*) AS count FROM tool_choice_capabilities").get()).toEqual({
				count: 1,
			});
		} finally {
			replacement.close();
		}
	});
});
describe("isForcedToolChoiceUnsupportedError", () => {
	it("matches unsupported forced tool_choice 400s", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(400, "tool_choice forces tool use is not compatible with this model"),
				true,
			),
		).toBe(true);
	});

	it("matches named tool choices rejected by the provider tool list", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(400, "Tool choice 'todo_write' not found in 'tools' parameter."),
				true,
			),
		).toBe(true);
	});

	it("keeps statusless invalid-request errors Codex-scoped", () => {
		const message = "Tool choice 'todo_write' not found in 'tools' parameter.";
		const error = Object.assign(new Error(message), { code: "invalid_request_error" });
		expect(isForcedToolChoiceUnsupportedError(error, true)).toBe(false);
		expect(isCodexStatuslessNamedToolChoiceNotFoundError(error, "todo_write", ["todo_write"])).toBe(true);
		expect(isCodexStatuslessNamedToolChoiceNotFoundError(error, "other", ["todo_write"])).toBe(false);
		expect(isCodexStatuslessNamedToolChoiceNotFoundError(error, "todo_write", ["search"])).toBe(false);
		expect(
			isCodexStatuslessNamedToolChoiceNotFoundError(
				Object.assign(new Error("tool_choice forces tool use is not compatible with this model"), {
					code: "invalid_request_error",
				}),
				"todo_write",
				["todo_write"],
			),
		).toBe(false);
		expect(
			isCodexStatuslessNamedToolChoiceNotFoundError(
				Object.assign(new Error(message), { code: "server_error" }),
				"todo_write",
				["todo_write"],
			),
		).toBe(false);
		expect(
			isCodexStatuslessNamedToolChoiceNotFoundError(
				Object.assign(new Error(message), { code: "invalid_request_error", status: 500 }),
				"todo_write",
				["todo_write"],
			),
		).toBe(false);
	});

	it("rejects non-400 errors", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(500, "tool_choice forces tool use is not compatible with this model"),
				true,
			),
		).toBe(false);
	});

	it("rejects requests that did not send forced tool_choice", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(400, "tool_choice forces tool use is not compatible with this model"),
				false,
			),
		).toBe(false);
	});

	it("rejects unrelated 400 messages", () => {
		expect(isForcedToolChoiceUnsupportedError(statusError(400, "invalid request body"), true)).toBe(false);
	});
});

const bedrockModel = {
	...model(),
	api: "bedrock-converse-stream",
	compat: { toolChoiceSupport: "required" },
} satisfies Model<"bedrock-converse-stream">;

const googleModel = {
	...model(),
	api: "google-generative-ai",
	compat: { toolChoiceSupport: "named" },
} satisfies Model<"google-generative-ai">;

void bedrockModel;
void googleModel;
