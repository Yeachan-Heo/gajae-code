import { describe, expect, it } from "bun:test";
import { CHAT_OPERATION_POLICY, sendAuthorizedChatOperation } from "../src/sdk/bus/chat-command-policy.js";
import { dispatchControl } from "../src/sdk/host/control/dispatch.js";
import type { ControlSurface } from "../src/sdk/host/control/operations.js";
import { createSdkSurfacePolicy } from "../src/sdk/host/surface-policy.js";
import {
	ADAPTERS,
	type AdapterDisposition,
	findOperation,
	OPERATIONS,
	TURN_RESULT_PROMPT_ALIAS,
	TURN_RESULT_SKILL_ALIAS,
} from "../src/sdk/protocol/operation-registry.js";

type InventoryRow = {
	sourceId: string;
	sourceKind: string;
	sdkId?: string;
	adapterMappings: Record<string, AdapterDisposition>;
	testIds: string[];
};
const inventoryPath = new URL("../src/sdk/protocol/operation-inventory.generated.json", import.meta.url);
const allowedDispositions = new Set<AdapterDisposition>([
	"native_alias",
	"generic_safe",
	"machine_only",
	"provider_only",
	"prohibited",
]);

const expectedDispositions: Record<string, Record<string, AdapterDisposition>> = {
	G02: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "machine_only",
		daemonCli: "machine_only",
	},
	C25: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "prohibited",
		daemonCli: "prohibited",
	},
	C26: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "prohibited",
		daemonCli: "prohibited",
	},
	C27: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "prohibited",
		daemonCli: "prohibited",
	},
	C28: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "prohibited",
		daemonCli: "prohibited",
	},
	C29: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "prohibited",
		daemonCli: "prohibited",
	},
	C30: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "prohibited",
		daemonCli: "prohibited",
	},
	Q29: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "generic_safe",
		acp: "generic_safe",
		daemonCli: "generic_safe",
	},
	Q30: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "generic_safe",
		acp: "generic_safe",
		daemonCli: "generic_safe",
	},
	C52: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "generic_safe",
		acp: "generic_safe",
		daemonCli: "generic_safe",
	},
	C38: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "provider_only",
		daemonCli: "machine_only",
	},
	C39: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "provider_only",
		daemonCli: "prohibited",
	},
	C40: {
		telegram: "prohibited",
		discord: "prohibited",
		slack: "prohibited",
		mcp: "prohibited",
		acp: "provider_only",
		daemonCli: "prohibited",
	},
};
describe("SDK operation matrix", () => {
	it("has a complete generated-registry bijection with adapter and test coverage", async () => {
		const inventory = (await Bun.file(inventoryPath).json()) as InventoryRow[];
		const registryInventory = inventory.filter(row => row.sourceKind === "registry");
		const registryById = new Map(OPERATIONS.map(operation => [operation.id, operation]));
		const inventoryIds = registryInventory.map(row => row.sourceId.replace("registry:", ""));
		expect(new Set(inventoryIds)).toEqual(new Set(registryById.keys()));
		expect(registryInventory).toHaveLength(97);

		for (const row of registryInventory) {
			const id = row.sourceId.startsWith("registry:") ? row.sourceId.slice("registry:".length) : row.sourceId;
			const operation = registryById.get(id);
			expect(operation, `generated row ${row.sourceId} has no registry operation`).toBeDefined();
			if (!operation) continue;
			expect(row.sdkId).toBe(operation.sdkId);
			expect(Object.keys(row.adapterMappings).sort()).toEqual([...ADAPTERS].sort());
			for (const disposition of Object.values(row.adapterMappings))
				expect(allowedDispositions.has(disposition)).toBe(true);
			expect(row.testIds.length).toBeGreaterThan(0);
			expect(operation.testIds.length).toBeGreaterThan(0);
		}
	});

	it("keeps control errors, query continuity, counts, and the stage-05 adapter partition explicit", () => {
		expect(OPERATIONS.filter(operation => operation.kind === "control")).toHaveLength(53);
		expect(OPERATIONS.filter(operation => operation.kind === "global")).toHaveLength(8);
		expect(OPERATIONS.filter(operation => operation.kind === "query")).toHaveLength(30);
		expect(OPERATIONS.filter(operation => operation.kind === "reverse")).toHaveLength(6);
		for (const operation of OPERATIONS.filter(operation => operation.kind === "control"))
			expect(operation.errorCodes.length).toBeGreaterThan(0);
		for (const operation of OPERATIONS.filter(operation => operation.kind === "query"))
			expect(operation.continuityClass).toBeDefined();
		for (const [id, disposition] of Object.entries(expectedDispositions))
			expect(OPERATIONS.find(operation => operation.id === id)?.adapterDispositions).toEqual(disposition);
	});
	it("resolves retained prompt and skill aliases to canonical Q26 and its error table", () => {
		const canonical = findOperation("query", "turn.result");
		for (const alias of [TURN_RESULT_PROMPT_ALIAS, TURN_RESULT_SKILL_ALIAS])
			expect(findOperation("query", alias)).toBe(canonical);
		expect(canonical).toMatchObject({
			id: "Q26",
			sdkId: "turn.result",
			aliases: [TURN_RESULT_PROMPT_ALIAS, TURN_RESULT_SKILL_ALIAS],
			errorCodes: ["invalid_request", "resource_gone"],
		});
	});

	it("gives every generated operation an explicit reviewed Discord and Slack chat disposition", () => {
		for (const transport of ["discord", "slack"] as const) {
			expect(Object.keys(CHAT_OPERATION_POLICY[transport]).sort()).toEqual(
				OPERATIONS.map(operation => operation.id).sort(),
			);
			for (const operation of OPERATIONS)
				expect(["allowed", "unsupported_on_chat"]).toContain(CHAT_OPERATION_POLICY[transport][operation.id]);
		}
	});

	it("rejects prohibited and unknown chat payloads before SDK send without echoing secrets", async () => {
		for (const transport of ["discord", "slack"] as const) {
			for (const request of [
				{ kind: "global" as const, operation: "session.get_endpoint" },
				{ kind: "global" as const, operation: "session.create" },
				{ kind: "global" as const, operation: "session.fork" },
				{ kind: "global" as const, operation: "session.resume" },
				{ kind: "global" as const, operation: "session.close" },
				{ kind: "global" as const, operation: "session.delete" },
				{ kind: "control" as const, operation: "bash.execute" },
				{ kind: "control" as const, operation: "bash.abort" },
				{ kind: "control" as const, operation: "bash.background" },
				{ kind: "control" as const, operation: "auth.login" },
				{ kind: "control" as const, operation: "host_tools.register" },
				{ kind: "control" as const, operation: "host_uri.register" },
				{ kind: "query" as const, operation: "artifact.read" },
				{ kind: "query" as const, operation: "resource.body" },
				{ kind: "query" as const, operation: "runtime.jobs.list" },
				{ kind: "query" as const, operation: "unknown.operation" },
			]) {
				let sends = 0;
				const result = await sendAuthorizedChatOperation(transport, request, async () => {
					sends++;
					return "sent";
				});
				expect(result).toMatchObject({ ok: false, error: { code: "unsupported_on_chat" } });
				expect(sends).toBe(0);
			}
			const secret = "discord-secret-token";
			let secretSends = 0;
			const secretResult = await sendAuthorizedChatOperation(
				transport,
				{ kind: "control", operation: "config.patch", input: { botToken: secret } },
				async () => {
					secretSends++;
					return "sent";
				},
			);
			expect(secretResult).toMatchObject({ ok: false, error: { code: "secret_input_forbidden" } });
			expect(secretSends).toBe(0);
			expect(JSON.stringify(secretResult)).not.toContain(secret);
		}
	});
	it("removes Broker lifecycle controls from host surfaces before mutation", async () => {
		const lifecycleOperations = [
			"session.new",
			"session.fork",
			"session.resume",
			"session.switch",
			"session.branch",
			"session.handoff",
			"session.delete",
		];
		const policy = createSdkSurfacePolicy({ bindings: ["sdkControl"], workflowGateAvailable: false });
		for (const operation of lifecycleOperations) expect(policy.installedControls.has(operation)).toBe(false);
		expect(policy.installedControls.has("session.rename")).toBe(true);
		expect(policy.installedControls.has("session.cwd.move")).toBe(true);

		let mutations = 0;
		const surface = new Proxy(
			{},
			{
				get: () => () => {
					mutations++;
				},
			},
		) as unknown as ControlSurface;
		for (const operation of lifecycleOperations) {
			const row = OPERATIONS.find(candidate => candidate.kind === "control" && candidate.sdkId === operation);
			const response = await dispatchControl(surface, row, {
				id: operation,
				operation,
				input: { id: "session-id", entryId: "entry-id", target: "target" },
				confirm: true,
			});
			expect(response).toMatchObject({
				ok: false,
				error: { code: "operation_prohibited" },
			});
		}
		expect(mutations).toBe(0);
	});
});
