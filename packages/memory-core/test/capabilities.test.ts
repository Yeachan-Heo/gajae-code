import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import { type MemoryCapabilities, memoryCapabilities } from "../src/index";
import { capabilitiesSchema, SCHEMA_REGISTRY, SCHEMA_VERSIONS } from "../src/schemas";

const CAPABILITIES_SCHEMA_VERSION = "gajae.memory.capabilities.v1";
const EXPECTED_SCHEMA_VERSIONS = {
	capabilities: "gajae.memory.capabilities.v1",
	initReceipt: "gajae.memory.init-receipt.v1",
	scopeResolution: "gajae.memory.scope-resolution.v1",
	searchResult: "gajae.memory.search-result.v1",
	recall: "gajae.memory.recall.v1",
	retrievalLedgerEntry: "gajae.memory.retrieval-ledger-entry.v1",
	error: "gajae.memory.error.v1",
	checkpoint: "gajae.memory.checkpoint.v1",
	handoff: "gajae.memory.handoff.v1",
	audit: "gajae.memory.audit.v1",
	writeProposal: "gajae.memory.write-proposal.v1",
	applyReceipt: "gajae.memory.apply-receipt.v1",
	forgetReceipt: "gajae.memory.forget-receipt.v1",
	resource: "gajae.memory.resource.v1",
} as const;
const MILESTONE_COMMANDS = [
	"init",
	"capabilities",
	"scopes",
	"resolve",
	"get",
	"search",
	"recall",
	"checkpoint",
	"resume",
	"doctor",
	"propose",
	"apply",
	"forget",
] as const;
const MILESTONE_AGENT_TOOLS = ["memory_recall", "memory_checkpoint", "memory_propose_write", "memory_forget"] as const;
const ABSENT_OPTIONAL_FEATURES = [
	"answer",
	"mcp",
	"embeddings",
	"graphrag",
	"legacy-data-migration",
	"remote-service",
] as const;

function asObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected a JSON object");
	}
	return value as Record<string, unknown>;
}

async function readCapabilitiesSchemaArtifact(): Promise<Record<string, unknown>> {
	const schemaPath = path.join(import.meta.dir, "../src/schemas/capabilities.v1.json");
	return asObject(JSON.parse(await Bun.file(schemaPath).text()));
}

const EXPECTED_CAPABILITIES = {
	schemaVersion: CAPABILITIES_SCHEMA_VERSION,
	packageVersion: "0.12.0",
	milestone: "M6",
	commands: MILESTONE_COMMANDS,
	agentTools: MILESTONE_AGENT_TOOLS,
	schemaVersions: EXPECTED_SCHEMA_VERSIONS,
	features: {
		deterministicRetrieval: true,
		writes: true,
		checkpointResume: true,
	},
	absentOptionalFeatures: ABSENT_OPTIONAL_FEATURES,
} as const satisfies MemoryCapabilities;

describe("memory-core M6 capabilities", () => {
	it("returns deterministic, deeply frozen M6 capabilities", () => {
		const first = memoryCapabilities();
		const second = memoryCapabilities();

		expect(first).toEqual(second);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first).toEqual(EXPECTED_CAPABILITIES);
		expect(packageManifest.version).toBe(first.packageVersion);

		for (const value of [
			first,
			first.commands,
			first.agentTools,
			first.schemaVersions,
			first.features,
			first.absentOptionalFeatures,
		]) {
			expect(Object.isFrozen(value)).toBe(true);
		}
	});

	it("matches the checked-in schema artifact and full registry", async () => {
		const artifact = (await readCapabilitiesSchemaArtifact()) as typeof capabilitiesSchema;
		const schemaProperties = asObject(artifact.properties);
		const registry = asObject(SCHEMA_REGISTRY);

		expect(capabilitiesSchema).toEqual(artifact);
		expect(Object.keys(registry)).toEqual(Object.keys(EXPECTED_SCHEMA_VERSIONS));
		expect(SCHEMA_REGISTRY.capabilities).toBe(capabilitiesSchema);
		expect(SCHEMA_REGISTRY.capabilities).toEqual(artifact);
		expect(Object.isFrozen(SCHEMA_REGISTRY)).toBe(true);
		expect(Object.isFrozen(SCHEMA_VERSIONS)).toBe(true);
		expect(SCHEMA_VERSIONS).toEqual(EXPECTED_SCHEMA_VERSIONS);

		const capabilities = memoryCapabilities();
		expect(artifact.$id).toBe(SCHEMA_VERSIONS.capabilities);
		expect(capabilities.schemaVersion).toBe(CAPABILITIES_SCHEMA_VERSION);
		expect(capabilities.schemaVersions).toEqual(EXPECTED_SCHEMA_VERSIONS);
		expect(artifact.additionalProperties).toBe(false);
		expect(artifact.required).toEqual([
			"schemaVersion",
			"packageVersion",
			"milestone",
			"commands",
			"agentTools",
			"schemaVersions",
			"features",
			"absentOptionalFeatures",
		]);

		expect(asObject(schemaProperties.schemaVersion).const).toBe(CAPABILITIES_SCHEMA_VERSION);
		expect(asObject(schemaProperties.packageVersion).const).toBe(packageManifest.version);
		expect(asObject(schemaProperties.milestone).const).toBe("M6");

		const commandSchema = asObject(schemaProperties.commands);
		expect(asObject(commandSchema.items).enum).toEqual(MILESTONE_COMMANDS);
		expect(commandSchema.minItems).toBe(MILESTONE_COMMANDS.length);
		expect(commandSchema.maxItems).toBe(MILESTONE_COMMANDS.length);
		expect(commandSchema.uniqueItems).toBe(true);
		expect(asObject(schemaProperties.agentTools).items).toEqual({ enum: MILESTONE_AGENT_TOOLS });
		expect(asObject(schemaProperties.agentTools).minItems).toBe(MILESTONE_AGENT_TOOLS.length);
		expect(asObject(schemaProperties.agentTools).maxItems).toBe(MILESTONE_AGENT_TOOLS.length);
		expect(asObject(schemaProperties.agentTools).uniqueItems).toBe(true);

		const schemaVersions = asObject(schemaProperties.schemaVersions);
		expect(schemaVersions.required).toEqual(Object.keys(EXPECTED_SCHEMA_VERSIONS));
		for (const [name, version] of Object.entries(EXPECTED_SCHEMA_VERSIONS)) {
			expect(asObject(asObject(schemaVersions.properties)[name]).const).toBe(version);
		}

		const features = asObject(schemaProperties.features);
		expect(asObject(features.properties).deterministicRetrieval).toEqual({ const: true });
		expect(asObject(features.properties).writes).toEqual({ const: true });
		expect(asObject(features.properties).checkpointResume).toEqual({ const: true });

		const absentFeatures = asObject(schemaProperties.absentOptionalFeatures);
		expect(asObject(absentFeatures.items).enum).toEqual(ABSENT_OPTIONAL_FEATURES);
		expect(absentFeatures.minItems).toBe(ABSENT_OPTIONAL_FEATURES.length);
		expect(absentFeatures.maxItems).toBe(ABSENT_OPTIONAL_FEATURES.length);
		expect(absentFeatures.uniqueItems).toBe(true);

		expect(capabilities.commands).toEqual(MILESTONE_COMMANDS);
		expect(capabilities.absentOptionalFeatures).toEqual(ABSENT_OPTIONAL_FEATURES);
		expect(asObject(SCHEMA_REGISTRY.searchResult).required).toEqual(expect.arrayContaining(["partial", "ledgerId"]));
		expect(asObject(SCHEMA_REGISTRY.recall).required).toEqual(expect.arrayContaining(["partial", "ledgerId"]));
	});
});
