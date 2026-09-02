import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTOROUTING_SELECTOR_MAX_LENGTH,
	AUTOROUTING_SELECTOR_PATTERN,
	type AutoroutingProvenance,
	type AutoroutingSetup,
	autoroutingProviderOrderHint,
	buildAutoroutingClearPatches,
	buildAutoroutingEnabledPatch,
	buildAutoroutingSettingsBatch,
	evaluateAutoroutingProvenanceState,
	isValidAutoroutingSelector,
	validateAutoroutingEffective,
	validateAutoroutingLocal,
	validateAutoroutingProvenance,
	validateAutoroutingSetup,
} from "../src/config/autorouting-contract";
import { canonicalJsonBytes } from "../src/config/autorouting-tier-map";
import { Settings } from "../src/config/settings";
import {
	type OptionalObjectDef,
	reconcileSettingsSchema,
	SETTINGS_SCHEMA,
	type SettingDef,
	type SettingValue,
	validateSettingPatch,
} from "../src/config/settings-schema";

const fingerprint = (value: unknown): string => createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");

const setup: AutoroutingSetup = {
	schema: 1,
	providers: ["anthropic", "openai-codex"],
	models: ["anthropic/claude-opus-5"],
};
const provenance: AutoroutingProvenance = {
	schema: 1,
	source: { catalogFingerprint: "a".repeat(64), mapFingerprint: "b".repeat(64), generatorVersion: 1 },
	declarationFingerprint: "c".repeat(64),
	tiersFingerprint: fingerprint({ fast: ["anthropic/claude-opus-5"] }),
};

function assertNever(value: never): never {
	throw new Error(`Unexpected setting definition ${(value as { type: string }).type}`);
}

function assertSettingDefExhaustive(definition: SettingDef): string {
	switch (definition.type) {
		case "boolean":
		case "string":
		case "number":
		case "enum":
		case "array":
		case "record":
		case "constrained-record":
		case "optional-object":
			return definition.type;
		default:
			return assertNever(definition);
	}
}

type SetupValueIsExact =
	SettingValue<"task.autorouting.setup"> extends AutoroutingSetup | undefined
		? AutoroutingSetup | undefined extends SettingValue<"task.autorouting.setup">
			? true
			: false
		: false;
const setupValueIsExact: SetupValueIsExact = true;

void setupValueIsExact;
void assertSettingDefExhaustive;

const validAutoroutingConfig = {
	task: {
		autorouting: {
			setup,
			provenance,
		},
	},
};

describe("autorouting typed settings contract", () => {
	it("covers optional-object SettingDef union exhaustiveness", () => {
		expect(assertSettingDefExhaustive(SETTINGS_SCHEMA["task.autorouting.setup"])).toBe("optional-object");
	});

	it("infers optional-object SettingValue as the typed object or undefined", () => {
		const value: SettingValue<"task.autorouting.setup"> = undefined;
		const objectValue: SettingValue<"task.autorouting.setup"> = setup;
		expect(value).toBeUndefined();
		expect(objectValue).toEqual(setup);
	});

	it("uses absent optional-object defaults and does not serialize them", () => {
		expect(SETTINGS_SCHEMA["task.autorouting.setup"].default).toBeUndefined();
		expect(SETTINGS_SCHEMA["task.autorouting.provenance"].default).toBeUndefined();
		const settings = Settings.isolated();
		expect(settings.get("task.autorouting.setup")).toBeUndefined();
		expect(settings.get("task.autorouting.provenance")).toBeUndefined();
	});

	it("registers optional-object paths as leaves", () => {
		const report = reconcileSettingsSchema({
			task: { autorouting: { setup, provenance } },
		});
		expect(report.report.issues.filter(issue => issue.kind === "unknown")).toEqual([]);
	});

	it("accepts plain objects while rejecting scalar and array optional-object values", () => {
		expect(reconcileSettingsSchema(validAutoroutingConfig).report.valid).toBe(true);
		expect(reconcileSettingsSchema({ task: { autorouting: { setup: "bad" } } }).report.valid).toBe(false);
		expect(reconcileSettingsSchema({ task: { autorouting: { setup: [] } } }).report.valid).toBe(false);
	});

	it("delegates optional-object validation exactly on valid, absent, malformed, and extra-property inputs", () => {
		expect(reconcileSettingsSchema({ task: { autorouting: { setup } } }).report.valid).toBe(true);
		expect(reconcileSettingsSchema({ task: { autorouting: {} } }).report.valid).toBe(true);
		const malformed = reconcileSettingsSchema({ task: { autorouting: { setup: { schema: 1, providers: [] } } } });
		expect(malformed.report.issues.some(issue => issue.path === "task.autorouting.setup.providers")).toBe(true);
		const extra = reconcileSettingsSchema({ task: { autorouting: { setup: { ...setup, unexpected: true } } } });
		expect(extra.report.issues.some(issue => issue.path === "task.autorouting.setup.unexpected")).toBe(true);

		const validateSetup = vi.spyOn(SETTINGS_SCHEMA["task.autorouting.setup"], "validate");
		try {
			reconcileSettingsSchema({ task: { autorouting: { tiers: { fast: ["a/model"] }, setup } } });
			expect(validateSetup).toHaveBeenCalledTimes(1);
		} finally {
			validateSetup.mockRestore();
		}

		const noTiers = reconcileSettingsSchema({
			task: {
				autorouting: {
					setup: { ...setup, providers: [] },
					provenance: { ...provenance, generatedAt: "forbidden" },
				},
			},
		});
		expect(noTiers.report.issues.some(issue => issue.path === "task.autorouting.setup.providers")).toBe(true);
		expect(noTiers.report.issues.some(issue => issue.path === "task.autorouting.provenance.generatedAt")).toBe(true);
	});

	it("rejects malformed nested autorouting objects at SDK patch ingress", () => {
		expect(validateSettingPatch({ "task.autorouting.setup": setup })).toEqual([]);
		expect(validateSettingPatch({ "task.autorouting.setup": { schema: 1, providers: [] } })).toEqual([
			expect.objectContaining({ path: "task.autorouting.setup" }),
		]);
		expect(
			validateSettingPatch({ "task.autorouting.provenance": { ...provenance, generatedAt: "forbidden" } }),
		).toEqual([expect.objectContaining({ path: "task.autorouting.provenance" })]);
		expect(validateSettingPatch({ "task.autorouting.tiers": { fast: ["bare-model"] } })).toEqual([
			expect.objectContaining({ path: "task.autorouting.tiers.fast.0" }),
		]);
	});
	it("rejects selectors longer than the routing-evidence bound before execution", () => {
		const longId = "m".repeat(AUTOROUTING_SELECTOR_MAX_LENGTH);
		expect(isValidAutoroutingSelector(`provider/${longId}`)).toBe(false);
		expect(isValidAutoroutingSelector(`provider/${"m".repeat(200)}`)).toBe(true);
		// The tiers validator must refuse the same over-long selector at config time.
		expect(validateAutoroutingLocal({ tiers: { fast: [`provider/${longId}`] } })).not.toEqual([]);
	});

	it("emits closed nested JSON schemas for setup and provenance", async () => {
		const schema = await Bun.file(new URL("../../../schemas/config.schema.json", import.meta.url).pathname).json();
		const autorouting = schema.properties.task.properties.autorouting;
		const setupSchema = autorouting.properties.setup;
		const provenanceSchema = autorouting.properties.provenance;
		expect(setupSchema.additionalProperties).toBe(false);
		expect(setupSchema.required).toEqual(["schema", "providers"]);
		expect(setupSchema.properties.providers).toMatchObject({ type: "array", minItems: 1, uniqueItems: true });
		expect(setupSchema.properties.providers.items).toMatchObject({
			minLength: 1,
			pattern: "^[^\\s](?:.*[^\\s])?$",
		});
		expect(setupSchema.properties.models.items).toMatchObject({
			minLength: 1,
			maxLength: AUTOROUTING_SELECTOR_MAX_LENGTH,
			pattern: AUTOROUTING_SELECTOR_PATTERN,
			not: { pattern: "^\\s*[pP][iI]/" },
		});
		expect(provenanceSchema.additionalProperties).toBe(false);
		expect(provenanceSchema.properties.source.additionalProperties).toBe(false);
		expect(provenanceSchema.properties.source.properties.generatorVersion).toMatchObject({
			type: "integer",
			minimum: 1,
		});
		expect(provenanceSchema.properties.declarationFingerprint.pattern).toBe("^[0-9a-f]{64}$");
		expect(JSON.stringify(provenanceSchema)).not.toContain("generatedAt");
	});

	it("accepts and rejects the local setup/provenance validator matrix", () => {
		expect(validateAutoroutingSetup(setup)).toEqual([]);
		expect(validateAutoroutingProvenance(provenance)).toEqual([]);
		expect(validateAutoroutingSetup({ schema: 1, providers: ["a", "a"] }).length).toBeGreaterThan(0);
		expect(validateAutoroutingSetup({ schema: 1, providers: ["a"], models: ["bare-model"] }).length).toBeGreaterThan(
			0,
		);
		expect(validateAutoroutingProvenance({ ...provenance, generatedAt: Date.now() }).length).toBeGreaterThan(0);
		expect(validateAutoroutingLocal({ setup, provenance })).toEqual([]);
		expect(validateAutoroutingLocal({ enabled: true, setup: { schema: 1, providers: [] } }).length).toBeGreaterThan(
			0,
		);
	});

	it("keeps effective enablement semantics independent of setup and provenance", () => {
		expect(validateAutoroutingEffective({ enabled: false, setup, provenance })).toEqual({ active: false });
		expect(validateAutoroutingEffective({ enabled: true, setup, provenance }).active).toBe(false);
		expect(
			validateAutoroutingEffective({ enabled: true, tiers: { fast: ["anthropic/model"] }, setup, provenance }),
		).toMatchObject({
			active: true,
		});
	});

	it("builds apply/refresh/clear as one three-key batch and toggle as a separate write", () => {
		expect(buildAutoroutingSettingsBatch({ tiers: { fast: ["anthropic/model"] }, setup, provenance })).toEqual([
			{ path: "task.autorouting.tiers", op: "set", value: { fast: ["anthropic/model"] } },
			{ path: "task.autorouting.setup", op: "set", value: setup },
			{ path: "task.autorouting.provenance", op: "set", value: provenance },
		]);
		expect(buildAutoroutingClearPatches()).toEqual([
			{ path: "task.autorouting.tiers", op: "unset" },
			{ path: "task.autorouting.setup", op: "unset" },
			{ path: "task.autorouting.provenance", op: "unset" },
		]);
		expect(buildAutoroutingEnabledPatch(true)).toEqual({ path: "task.autorouting.enabled", op: "set", value: true });
	});

	it("keeps an atomic batch all-or-nothing when a later patch is invalid", async () => {
		const settings = Settings.isolated({
			"task.autorouting.tiers": { fast: ["before/model"] },
			"task.autorouting.setup": setup,
			"task.autorouting.provenance": provenance,
		});
		const before = {
			tiers: settings.get("task.autorouting.tiers"),
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
		};
		await expect(
			settings.commitAtomicBatch([
				{ path: "task.autorouting.tiers", op: "set", value: { fast: ["after/model"] } },
				{ path: "task.autorouting.setup", op: "set", value: undefined } as never,
			]),
		).rejects.toThrow();
		expect(settings.get("task.autorouting.tiers")).toEqual(before.tiers);
		expect(settings.get("task.autorouting.setup")).toEqual(before.setup);
		expect(settings.get("task.autorouting.provenance")).toEqual(before.provenance);
	});

	it("detects stale map, stale catalog, and hand-edited tiers", () => {
		const tiers = { fast: ["anthropic/model"] };
		const current = { catalogFingerprint: "a".repeat(64), mapFingerprint: "b".repeat(64), tiers };
		const fresh = {
			...provenance,
			source: {
				catalogFingerprint: current.catalogFingerprint,
				mapFingerprint: current.mapFingerprint,
				generatorVersion: 1,
			},
			tiersFingerprint: fingerprint(tiers),
		};
		expect(evaluateAutoroutingProvenanceState(fresh, current)).toEqual({
			staleMap: false,
			staleCatalog: false,
			handEdited: false,
		});
		expect(evaluateAutoroutingProvenanceState(fresh, { ...current, mapFingerprint: "c".repeat(64) })).toMatchObject({
			staleMap: true,
		});
		expect(
			evaluateAutoroutingProvenanceState(fresh, { ...current, catalogFingerprint: "d".repeat(64) }),
		).toMatchObject({
			staleCatalog: true,
		});
		expect(
			evaluateAutoroutingProvenanceState(fresh, { ...current, tiers: { ...tiers, balanced: ["other/model"] } }),
		).toMatchObject({
			handEdited: true,
		});
	});

	it("round-trips an untouched config byte-for-byte with absent optional-object keys", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorouting-settings-"));
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		const config = "configSchemaVersion: 2\ntask:\n  autorouting:\n    enabled: false\n    preset: anthropic\n";
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, config);
		try {
			const settings = await Settings.loadForScope({ cwd, agentDir });
			await settings.flush();
			expect(await Bun.file(configPath).text()).toBe(config);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

// Keep the generic type in the test source so tsc verifies the public contract.
const optionalObjectDef: OptionalObjectDef<AutoroutingSetup> = SETTINGS_SCHEMA["task.autorouting.setup"];
void optionalObjectDef;

describe("autoroutingProviderOrderHint", () => {
	it("reports no drift when the declaration matches the current priority", () => {
		expect(autoroutingProviderOrderHint(["anthropic", "google"], ["anthropic", "google", "xai"])).toEqual({
			reordered: false,
			missing: [],
		});
	});

	it("treats an order-preserving subset as unchanged", () => {
		expect(autoroutingProviderOrderHint(["anthropic", "xai"], ["anthropic", "google", "xai"])).toEqual({
			reordered: false,
			missing: [],
		});
	});

	it("flags a swap of two declared providers", () => {
		expect(autoroutingProviderOrderHint(["google", "anthropic"], ["anthropic", "google"])).toEqual({
			reordered: true,
			missing: [],
		});
	});

	it("lists declared providers the catalog no longer offers, preserving their spelling", () => {
		expect(autoroutingProviderOrderHint(["anthropic", "CustomRouter"], ["anthropic"])).toEqual({
			reordered: false,
			missing: ["CustomRouter"],
		});
	});

	it("normalizes case and whitespace the way provider selection does", () => {
		expect(autoroutingProviderOrderHint([" Anthropic ", "GOOGLE"], ["anthropic", "google"])).toEqual({
			reordered: false,
			missing: [],
		});
	});

	it("ignores duplicate declarations rather than reporting false drift", () => {
		expect(autoroutingProviderOrderHint(["anthropic", "anthropic", "google"], ["anthropic", "google"])).toEqual({
			reordered: false,
			missing: [],
		});
	});
});
