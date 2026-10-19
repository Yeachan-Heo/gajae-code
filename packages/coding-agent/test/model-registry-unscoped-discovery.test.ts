import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractGoogleOAuthProjectId, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@gajae-code/utils";

let tempDir: string;
let modelsJsonPath: string;
let authStorage: AuthStorage;
let previousPresetRegistryDisabled: string | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
	Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
	tempDir = path.join(os.tmpdir(), `pi-test-unscoped-discovery-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	modelsJsonPath = path.join(tempDir, "models.json");
	authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
});

afterEach(() => {
	resetSettingsForTest();
	authStorage.close();
	if (previousPresetRegistryDisabled === undefined) delete Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
	else Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = previousPresetRegistryDisabled;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("unscoped Google discovery", () => {
	test("a discovery refresh without a credential session remains visible to unscoped readers", async () => {
		await authStorage.set("google-antigravity", [
			{
				type: "oauth",
				access: "unscoped-access",
				refresh: "unscoped-refresh",
				expires: Date.now() + 60 * 60_000,
				projectId: "unscoped-project",
			},
		]);
		using _hook = hookFetch((input, init) => {
			if (!String(input).endsWith("/v1internal:fetchAvailableModels")) {
				throw new Error(`Unexpected URL: ${String(input)}`);
			}
			const body = JSON.parse(String(init?.body ?? "{}")) as { project?: string };
			expect(body.project).toBe("unscoped-project");
			return new Response(
				JSON.stringify({ models: { "unscoped-discovered-model": { displayName: "Unscoped Discovered" } } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		try {
			// `--list-models` refreshes and reads without a credential session.
			await registry.refreshProvider("google-antigravity", "online");
			const ids = registry
				.getAvailable()
				.filter(model => model.provider === "google-antigravity")
				.map(model => model.id);
			expect(ids).toContain("unscoped-discovered-model");
		} finally {
			await registry.dispose();
		}
	});

	test("background refreshes coalesce per credential context instead of dropping later sessions", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const contextA = Promise.withResolvers<void>();
		const contextB = Promise.withResolvers<void>();
		const calls: Array<string | undefined> = [];
		const refresh = vi.spyOn(registry, "refresh").mockImplementation(async (_strategy, sessionId) => {
			calls.push(sessionId);
			if (sessionId === "session-a") await contextA.promise;
			else await contextB.promise;
		});
		try {
			registry.refreshInBackground("online-if-uncached", "session-a");
			registry.refreshInBackground("online-if-uncached", "session-b");
			// An equivalent context still coalesces behind its own pending refresh.
			registry.refreshInBackground("online-if-uncached", "session-a");
			expect(calls).toEqual(["session-a", "session-b"]);

			contextA.resolve();
			contextB.resolve();
			await Bun.sleep(0);
			await Bun.sleep(0);
			expect(refresh).toHaveBeenCalledTimes(2);

			// Both contexts are settled and may refresh again.
			registry.refreshInBackground("online-if-uncached", "session-a");
			expect(calls).toEqual(["session-a", "session-b", "session-a"]);
			contextA.resolve();
		} finally {
			refresh.mockRestore();
			await registry.dispose();
		}
	});
});

describe("extractGoogleOAuthProjectId properties", () => {
	const accessToken = "property-access-token";
	// Deterministic mulberry32: every run exercises the same generated corpus.
	function random(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let value = state;
			value = Math.imul(value ^ (value >>> 15), value | 1);
			value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
			return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
		};
	}
	const next = random(0x6734);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;

	test("structured metadata agrees with the documented precedence", () => {
		for (let iteration = 0; iteration < 400; iteration++) {
			const token = pick([accessToken, ` ${accessToken} `, "other-token", 7, null, undefined]);
			const primary = pick([
				"project-primary",
				"  padded-project  ",
				"",
				"   ",
				42,
				null,
				undefined,
				["project-primary"],
			]);
			const secondary = pick([
				"project-secondary",
				"  padded-secondary  ",
				"",
				7,
				null,
				undefined,
				{ project: "object" },
			]);
			const metadata: Record<string, unknown> = { token };
			if (next() < 0.8 && primary !== undefined) metadata.projectId = primary;
			if (next() < 0.8 && secondary !== undefined) metadata.project_id = secondary;
			if (next() < 0.3) metadata.extra = "preserved";
			const raw = JSON.stringify(metadata);

			const result = extractGoogleOAuthProjectId(raw, accessToken);
			const tokenMatches = typeof token === "string" && token.trim() === accessToken;
			if (!tokenMatches) {
				expect(result, raw).toBeUndefined();
				continue;
			}
			const selected = typeof metadata.projectId === "string" ? metadata.projectId : metadata.project_id;
			const expected = typeof selected === "string" ? selected.trim() || undefined : undefined;
			expect(result, raw).toBe(expected);
		}
	});

	test("malformed and truncated inputs never throw", () => {
		const fragments = ["", "{", "}", '{"token":', '{"token":"property-access-token"', "null", "[]", '"text"', "42"];
		for (let iteration = 0; iteration < 400; iteration++) {
			const raw = Array.from({ length: Math.floor(next() * 3) + 1 }, () => pick(fragments)).join("");
			expect(() => extractGoogleOAuthProjectId(raw.length === 0 ? undefined : raw, accessToken)).not.toThrow();
		}
	});
});
