import { describe, expect, it } from "bun:test";
import { CursorRegistry } from "../src/sdk/host/query/cursor.js";
import { QueryHandlers, type SessionSurface } from "../src/sdk/host/query/handlers.js";
import { RevisionStore } from "../src/sdk/host/query/revision-store.js";
import { findOperation } from "../src/sdk/protocol/operation-registry.js";
import { projectActiveProviderDescriptors } from "../src/sdk/providers.js";

function surface(getActiveProviders: SessionSurface["getActiveProviders"]): SessionSurface {
	return {
		getTranscriptEntries: () => [],
		getContextSnapshot: () => ({}),
		getGoalState: () => undefined,
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getActiveProviders,
		getGates: () => [],
		getConfigItems: () => [],
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => undefined,
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => [],
		getExtensions: () => [],
		getJobs: () => [],
		installedQueries: new Set(["providers.list/active", "models.list/current"]),
	};
}

async function queryActiveProviders(getActiveProviders: SessionSurface["getActiveProviders"], id?: string) {
	const revisions = new RevisionStore("session");
	const cursors = new CursorRegistry("token", revisions);
	const handlers = new QueryHandlers(surface(getActiveProviders), "session", revisions, cursors);
	return handlers.dispatch({ query: "providers.list/active", connectionId: "connection", ...(id ? { id } : {}) });
}

describe("Q28 providers.list/active", () => {
	it("projects one minimal descriptor per provider through the standard snapshot page", async () => {
		const response = await queryActiveProviders(() => [
			{ provider: "anthropic", connectionKind: "credential" },
			{ provider: "openai", connectionKind: "credentialless" },
		]);

		expect(response).toEqual({
			id: undefined,
			ok: true,
			page: {
				items: [
					{ provider: "anthropic", connectionKind: "credential" },
					{ provider: "openai", connectionKind: "credentialless" },
				],
				complete: true,
				revision: "1",
			},
		});
		expect(response.page?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ provider: "anthropic" }),
				expect.objectContaining({ provider: "openai" }),
			]),
		);
		for (const item of response.page?.items ?? [])
			expect(Object.keys(item as object).sort()).toEqual(["connectionKind", "provider"]);
	});
	it("strips unexpected fields, deduplicates with credential precedence, and sorts by UTF-8", () => {
		const input = [
			{ provider: "zeta", connectionKind: "credentialless", unexpected: "secret" },
			{ provider: "zeta", connectionKind: "credential", dynamic: { token: "secret" } },
			{ provider: "alpha", connectionKind: "credential", extra: true },
			{ provider: "é", connectionKind: "credentialless", partial: "secret" },
		];
		expect(projectActiveProviderDescriptors(input)).toEqual([
			{ provider: "alpha", connectionKind: "credential" },
			{ provider: "zeta", connectionKind: "credential" },
			{ provider: "é", connectionKind: "credentialless" },
		]);
		expect(() => projectActiveProviderDescriptors([{ provider: "invalid", connectionKind: "unsupported" }])).toThrow(
			"Invalid active provider connection kind.",
		);
	});

	it("maps resolver failures to the fixed safe error and preserves only the request id", async () => {
		const response = await queryActiveProviders(() => {
			throw new Error("credential=super-secret dynamic details");
		}, "request-26");

		expect(response).toEqual({
			id: "request-26",
			ok: false,
			error: { code: "internal", message: "Unable to resolve active providers." },
		});
		expect(response).not.toHaveProperty("page");
		expect(response).not.toHaveProperty("restartQuery");
		expect(JSON.stringify(response)).not.toContain("super-secret");
	});
	it("maps resolver failures without a request id to the fixed safe error", async () => {
		const response = await queryActiveProviders(() => {
			throw new Error("dynamic credentials and partial details");
		});

		expect(response.id).toBeUndefined();
		expect(response.ok).toBe(false);
		expect(response.error).toEqual({
			code: "internal",
			message: "Unable to resolve active providers.",
		});
		expect(response).not.toHaveProperty("page");
		expect(response).not.toHaveProperty("restartQuery");
		expect(response).not.toHaveProperty("partial");
		expect(JSON.stringify(response)).not.toContain("dynamic");
		expect(JSON.stringify(response)).not.toContain("credentials");
	});

	it("registers Q28 as an append-only generic-safe scalar snapshot query", () => {
		const operation = findOperation("query", "providers.list/active");
		expect(operation).toMatchObject({
			id: "Q28",
			sdkId: "providers.list/active",
			idempotency: "idempotent",
			continuityClass: "scalar_snapshot",
			errorCodes: ["invalid_request", "resource_gone", "internal"],
		});
		expect(operation?.adapterDispositions).toEqual({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "generic_safe",
			acp: "generic_safe",
			daemonCli: "generic_safe",
		});
	});
});
