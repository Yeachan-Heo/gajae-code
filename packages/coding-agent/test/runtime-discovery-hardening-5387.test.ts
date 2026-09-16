import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, readModelCache } from "@gajae-code/ai/core";
import {
	ModelRegistry as ModelRegistryImpl,
	scrubDiscoveryError,
} from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";

/**
 * Runtime hardening for the OpenAI `/v1/models` discovery path that a
 * discovery-only custom-provider add hands off to (issue #5387 review).
 * The setup probe is bounded and sanitized; these tests pin the same
 * guarantees on the runtime path: bounded bodies, safe-ID admission,
 * credential-safe errors, and no cache publication on failure.
 */
describe("runtime models-list discovery hardening", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `gjc-runtime-discovery-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  hardened:",
				"    baseUrl: https://hardened.example.com/v1",
				"    apiKey: sk-hardened",
				"    auth: apiKey",
				"    api: openai-completions",
				"    models: []",
			].join("\n"),
		);
	});

	afterEach(async () => {
		authStorage.close();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	function cacheDbPath(): string {
		return path.join(tempDir, "models.db");
	}

	test("rejects a declared oversized body without buffering it", async () => {
		using _hook = hookFetch(
			() =>
				new Response("x".repeat(16), {
					status: 200,
					headers: { "Content-Type": "application/json", "Content-Length": "2000000" },
				}),
		);
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		const state = registry.getProviderDiscoveryState("hardened");
		expect(state?.status).toBe("unavailable");
		expect(registry.getAll().filter(model => model.provider === "hardened")).toEqual([]);
		// Only a failed-fetch tombstone may be recorded: no models, and
		// non-authoritative so it can never serve a catalog.
		const cached = readModelCache<Api>("hardened", 24 * 60 * 60 * 1000, Date.now, cacheDbPath());
		expect(cached?.models).toEqual([]);
		expect(cached?.authoritative).toBe(false);
	});

	test("rejects a streamed body that overflows the size limit", async () => {
		const big = "y".repeat(2_000_000);
		using _hook = hookFetch(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(big));
							controller.close();
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		expect(registry.getProviderDiscoveryState("hardened")?.status).toBe("unavailable");
		expect(registry.getAll().filter(model => model.provider === "hardened")).toEqual([]);
	});

	test("drops unsafe wire IDs from the live catalog", async () => {
		using _hook = hookFetch(
			() =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "good-model" },
							{ id: "bad\nnewline" },
							{ id: "badansi" },
							{ id: "x".repeat(300) },
							{ id: "  " },
							{ id: 42 },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		expect(
			registry
				.getAll()
				.filter(model => model.provider === "hardened")
				.map(model => model.id),
		).toEqual(["good-model"]);
	});

	test("falls back to the safe ID when the wire name is unsafe", async () => {
		using _hook = hookFetch(
			() =>
				new Response(
					JSON.stringify({
						data: [{ id: "good-model", name: "evil\nname" }, { id: "plain-model" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		const models = registry.getAll().filter(model => model.provider === "hardened");
		expect(models.map(model => `${model.id}/${model.name}`).sort()).toEqual([
			"good-model/good-model",
			"plain-model/plain-model",
		]);
	});

	test("redacts the bearer from transport failure state", async () => {
		using _hook = hookFetch(() => {
			throw new Error("socket hang up (Authorization: Bearer sk-hardened)");
		});
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		const state = registry.getProviderDiscoveryState("hardened");
		expect(state?.status).toBe("unavailable");
		expect(state?.error ?? "").not.toContain("sk-hardened");
	});

	test("scrubDiscoveryError redacts resolved secrets and preserves Error identity", () => {
		const original = new Error("boom Bearer sk-hardened end");
		const scrubbed = scrubDiscoveryError(original, ["sk-hardened", undefined]) as Error;
		expect(scrubbed).toBe(original);
		expect(scrubbed.message).toBe("boom Bearer [redacted] end");
		expect(scrubDiscoveryError("plain sk-hardened text", ["sk-hardened"])).toBe("plain [redacted] text");
	});

	test("treats malformed and non-JSON bodies as unavailable without publishing cache", async () => {
		for (const body of ["not json at all", JSON.stringify({ unexpected: "shape" })]) {
			using _hook = hookFetch(
				() => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
			);
			const registry = new ModelRegistryImpl(authStorage, modelsPath);
			await registry.refreshProvider("hardened");
			expect(registry.getProviderDiscoveryState("hardened")?.status).toBe("unavailable");
			expect(registry.getAll().filter(model => model.provider === "hardened")).toEqual([]);
		}
		const cached = readModelCache<Api>("hardened", 24 * 60 * 60 * 1000, Date.now, cacheDbPath());
		expect(cached?.models).toEqual([]);
		expect(cached?.authoritative).toBe(false);
	});

	test("surfaces generic HTTP failures as unavailable with a redacted endpoint", async () => {
		using _hook = hookFetch(() => new Response("oops", { status: 500 }));
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		const state = registry.getProviderDiscoveryState("hardened");
		expect(state?.status).toBe("unavailable");
		expect(state?.error ?? "").toContain("https://hardened.example.com/v1/models");
		expect(state?.error ?? "").not.toContain("sk-hardened");
	});

	test("rejects credentials on HTTP 401 without leaking the key", async () => {
		using _hook = hookFetch(() => new Response("denied", { status: 401 }));
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("hardened");
		const state = registry.getProviderDiscoveryState("hardened");
		expect(state?.status).toBe("unavailable");
		expect(state?.error ?? "").toContain("credential was rejected");
		expect(state?.error ?? "").not.toContain("sk-hardened");
	});
});
