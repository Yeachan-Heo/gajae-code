import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	reconcileSettingsSchema,
	type SettingPath,
	validateSettingPatch,
} from "@gajae-code/coding-agent/config/settings-schema";
import { EditTool } from "@gajae-code/coding-agent/edit";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import {
	DEFAULT_EDIT_MODE,
	detectModelEditFamily,
	type EditMode,
	type EditModeSessionLike,
	type ModelEditFamily,
	resolveEditMode,
	resolveEditModeDetails,
	resolveForcedEnvEditMode,
} from "@gajae-code/coding-agent/utils/edit-mode";

// ─── Env isolation ───────────────────────────────────────────────────────────

let savedGjcVariant: string | undefined;
let savedPiVariant: string | undefined;

beforeEach(() => {
	savedGjcVariant = Bun.env.GJC_EDIT_VARIANT;
	savedPiVariant = Bun.env.PI_EDIT_VARIANT;
	delete Bun.env.GJC_EDIT_VARIANT;
	delete Bun.env.PI_EDIT_VARIANT;
});

afterEach(() => {
	if (savedGjcVariant === undefined) delete Bun.env.GJC_EDIT_VARIANT;
	else Bun.env.GJC_EDIT_VARIANT = savedGjcVariant;
	if (savedPiVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
	else Bun.env.PI_EDIT_VARIANT = savedPiVariant;
	resetSettingsForTest();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(options: {
	editMode?: string;
	modelVariants?: Record<string, string>;
	model?: string;
	catalogEditMode?: EditMode;
}): EditModeSessionLike {
	const globalSettings: Partial<Record<SettingPath, unknown>> = {};
	if (options.editMode !== undefined) {
		globalSettings["edit.mode"] = options.editMode;
	}
	if (options.modelVariants) {
		globalSettings["edit.modelVariants"] = options.modelVariants as never;
	}
	const settings = Settings.isolated(globalSettings);
	return {
		settings,
		getActiveModelString: () => options.model,
		...(options.catalogEditMode ? { getCatalogEditMode: () => options.catalogEditMode } : {}),
	};
}

// ─── Family detection ────────────────────────────────────────────────────────

describe("detectModelEditFamily", () => {
	const cases: Array<[string, ModelEditFamily, EditMode]> = [
		["openai/gpt-5.4", "gpt", "apply_patch"],
		["openrouter/openai/gpt-5.4", "gpt", "apply_patch"],
		["custom/gpt-oss-120b", "gpt", "apply_patch"],
		["company/openai.gpt-5.4", "gpt", "apply_patch"],
		["openai/gpt-5.3-codex", "codex", "apply_patch"],
		["custom/codex-specialized", "codex", "apply_patch"],
		["anthropic/claude-sonnet-4-6", "claude", "replace"],
		["custom/claude-opus-4-5", "claude", "replace"],
		["amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude", "replace"],
		["deepseek/deepseek-v3.2", "deepseek", "replace"],
		["amazon-bedrock/us.deepseek.r1-v1:0", "deepseek", "replace"],
		["gitlab-duo/duo-chat-gpt-5-2-codex", "codex", "apply_patch"],
		["venice/openai-gpt-52-codex", "codex", "apply_patch"],
		["custom/qwen3-coder", "qwen", "replace"],
		["minimax-code/minimax-m2.5", "minimax", "hashline"],
		["zai/glm-4.7", "glm", "hashline"],
		["moonshotai/kimi-k2.5", "kimi", "hashline"],
		["custom/moonshot-v1-code", "kimi", "hashline"],
		["custom/not-a-codex-model", "unknown", "hashline"],
		["custom/gpt-not-a-codex-model", "unknown", "hashline"],
		["custom/gptx-codex", "unknown", "hashline"],
		["custom/not-gpt-5-codex", "unknown", "hashline"],
		["custom/gpt-5foo", "unknown", "hashline"],
		["custom/gpt-5foo-bar", "unknown", "hashline"],
		["custom/company-code-model", "unknown", "hashline"],
		["custom/not-a-glm-model", "unknown", "hashline"],
	];

	for (const [modelId, family, mode] of cases) {
		test(`${modelId} → ${family} → ${mode}`, () => {
			expect(detectModelEditFamily(modelId)).toBe(family);
			const session = makeSession({ editMode: "auto", model: modelId });
			expect(resolveEditMode(session)).toBe(mode);
		});
	}

	test("routes by model segment, not provider name", () => {
		// Provider names containing family tokens must not classify the model.
		expect(detectModelEditFamily("glm-hosting/company-model")).toBe("unknown");
		expect(detectModelEditFamily("openai/o3")).toBe("unknown");
		expect(detectModelEditFamily("openai/o4-mini")).toBe("unknown");
	});

	test("case/whitespace-insensitive and undefined-safe", () => {
		expect(detectModelEditFamily("  Anthropic/Claude-Sonnet-4-6 ")).toBe("claude");
		expect(detectModelEditFamily(undefined)).toBe("unknown");
		expect(detectModelEditFamily("")).toBe("unknown");
	});
});

// ─── Precedence ──────────────────────────────────────────────────────────────

describe("resolveEditModeDetails precedence", () => {
	test("environment force beats every other source", () => {
		Bun.env.GJC_EDIT_VARIANT = "vim";
		const session = makeSession({
			editMode: "replace",
			modelVariants: { "gpt-5.4": "hashline" },
			model: "openai/gpt-5.4",
			catalogEditMode: "patch",
		});
		const details = resolveEditModeDetails(session);
		expect(details.mode).toBe("vim");
		expect(details.source).toBe("environment");
	});

	test("legacy PI_EDIT_VARIANT still forces", () => {
		Bun.env.PI_EDIT_VARIANT = "patch";
		const details = resolveEditModeDetails(makeSession({ model: "openai/gpt-5.4" }));
		expect(details.mode).toBe("patch");
		expect(details.source).toBe("environment");
	});

	test("GJC_EDIT_VARIANT=auto means not forced", () => {
		Bun.env.GJC_EDIT_VARIANT = "auto";
		expect(resolveForcedEnvEditMode()).toBeUndefined();
		expect(resolveEditMode(makeSession({ model: "openai/gpt-5.4" }))).toBe("apply_patch");
	});

	test("matching modelVariants beats explicit edit.mode", () => {
		const session = makeSession({
			editMode: "replace",
			modelVariants: { "gpt-5.4": "hashline" },
			model: "custom-company/gpt-5.4",
		});
		const details = resolveEditModeDetails(session);
		expect(details.mode).toBe("hashline");
		expect(details.source).toBe("model-override");
		expect(details.matchedRule).toBe("gpt-5.4");
	});

	test("explicit non-auto edit.mode beats catalog and family mapping", () => {
		const session = makeSession({
			editMode: "vim",
			model: "openai/gpt-5.4",
			catalogEditMode: "replace",
		});
		const details = resolveEditModeDetails(session);
		expect(details.mode).toBe("vim");
		expect(details.source).toBe("setting");
	});

	test("catalog recommendation beats built-in family mapping", () => {
		const session = makeSession({
			editMode: "auto",
			model: "openai/gpt-5.4",
			catalogEditMode: "replace",
		});
		const details = resolveEditModeDetails(session);
		expect(details.mode).toBe("replace");
		expect(details.source).toBe("catalog");
		expect(details.family).toBe("gpt");
	});

	test("built-in mapping beats fallback", () => {
		const details = resolveEditModeDetails(makeSession({ editMode: "auto", model: "anthropic/claude-sonnet-4-6" }));
		expect(details.mode).toBe("replace");
		expect(details.source).toBe("builtin-family");
		expect(details.family).toBe("claude");
	});

	test("unknown model falls back to hashline", () => {
		const details = resolveEditModeDetails(makeSession({ editMode: "auto", model: "custom/company-code-model" }));
		expect(details.mode).toBe(DEFAULT_EDIT_MODE);
		expect(details.source).toBe("fallback");
		expect(details.family).toBe("unknown");
	});

	test("missing model falls back to hashline under auto", () => {
		const details = resolveEditModeDetails(makeSession({ editMode: "auto" }));
		expect(details.mode).toBe("hashline");
		expect(details.source).toBe("fallback");
	});

	test("default settings resolve to auto routing", () => {
		// Schema default is now `auto`; no explicit edit.mode configured.
		expect(resolveEditMode(makeSession({ model: "openai/gpt-5.4" }))).toBe("apply_patch");
		expect(resolveEditMode(makeSession({ model: "deepseek/deepseek-v3.2" }))).toBe("replace");
		expect(resolveEditMode(makeSession({ model: "zai/glm-4.7" }))).toBe("hashline");
		expect(resolveEditMode(makeSession({}))).toBe("hashline");
	});

	test("invalid environment value fails fast", () => {
		Bun.env.GJC_EDIT_VARIANT = "definitely-not-a-mode";
		expect(() => resolveEditMode(makeSession({ model: "openai/gpt-5.4" }))).toThrow(/Invalid GJC_EDIT_VARIANT/);
	});

	test.each([
		"toString",
		"constructor",
		"__proto__",
	])("rejects inherited property name %s in GJC_EDIT_VARIANT", value => {
		Bun.env.GJC_EDIT_VARIANT = value;
		expect(() => resolveEditMode(makeSession({ model: "openai/gpt-5.4" }))).toThrow(/Invalid GJC_EDIT_VARIANT/);
	});

	test("invalid matched model override fails closed", () => {
		const session = makeSession({
			editMode: "replace",
			modelVariants: { "gpt-5.4": "atom" },
			model: "custom/gpt-5.4",
		});
		expect(() => resolveEditModeDetails(session)).toThrow(/Invalid edit\.modelVariants value "atom"/);
	});

	test.each([
		"toString",
		"constructor",
		"__proto__",
	])("rejects inherited property name %s in a matched model override", value => {
		const session = makeSession({
			editMode: "auto",
			modelVariants: { "gpt-5.4": value },
			model: "custom/gpt-5.4",
		});
		expect(() => resolveEditModeDetails(session)).toThrow(/Invalid edit\.modelVariants value/);
	});

	test("non-matching invalid entries do not affect another model", () => {
		const session = makeSession({
			editMode: "auto",
			modelVariants: { "gpt-5.4": "atom" },
			model: "anthropic/claude-sonnet-4-6",
		});
		const details = resolveEditModeDetails(session);
		expect(details.mode).toBe("replace");
		expect(details.source).toBe("builtin-family");
	});
});

test("edit.modelVariants is a typed published setting with enum-validated values", () => {
	const settings = Settings.isolated({ "edit.modelVariants": { "gpt-5.4": "hashline" } });
	expect(settings.get("edit.modelVariants")).toEqual({ "gpt-5.4": "hashline" });
	expect(validateSettingPatch({ "edit.modelVariants": { "gpt-5.4": "apply_patch" } })).toEqual([]);
	expect(validateSettingPatch({ "edit.modelVariants": { "gpt-5.4": 42 } })).toEqual([
		{ path: "edit.modelVariants.gpt-5.4", detail: "Expected string-enum." },
	]);
	expect(reconcileSettingsSchema({ edit: { modelVariants: { "gpt-5.4": "bogus" } } }).report.valid).toBe(false);
});

// ─── Settings integration ────────────────────────────────────────────────────

describe("Settings.matchEditVariantForModel", () => {
	test("returns raw matched value including invalid ones", () => {
		const settings = Settings.isolated({
			"edit.modelVariants": { "gpt-5.4": "bogus", claude: "replace" } as never,
		});
		expect(settings.matchEditVariantForModel("custom/gpt-5.4")).toEqual({ pattern: "gpt-5.4", value: "bogus" });
		expect(settings.matchEditVariantForModel("anthropic/claude-opus")).toEqual({
			pattern: "claude",
			value: "replace",
		});
		expect(settings.matchEditVariantForModel("zai/glm-4.7")).toBeNull();
		expect(settings.matchEditVariantForModel(undefined)).toBeNull();
	});

	test("ignores own prototype-key model variant rules", () => {
		const modelVariants = Object.create(null) as Record<string, string>;
		Object.defineProperty(modelVariants, "__proto__", { enumerable: true, value: "replace" });
		const settings = Settings.isolated({ "edit.modelVariants": modelVariants });
		expect(settings.matchEditVariantForModel("custom/__proto__")).toBeNull();
		expect(settings.getEditVariantForModel("custom/__proto__")).toBeNull();
	});

	test("ignores invalid model variant containers", () => {
		const settings = Settings.isolated({ "edit.modelVariants": ["replace"] as never });
		expect(settings.matchEditVariantForModel("custom/0")).toBeNull();
		expect(settings.getEditVariantForModel("custom/0")).toBeNull();
	});

	test("resolver consumes Settings match with model-override provenance", () => {
		const settings = Settings.isolated({
			"edit.modelVariants": { "qwen3-coder-small": "hashline" },
		});
		const details = resolveEditModeDetails({
			settings,
			getActiveModelString: () => "local/qwen3-coder-small",
		});
		expect(details.mode).toBe("hashline");
		expect(details.source).toBe("model-override");
		expect(details.matchedRule).toBe("qwen3-coder-small");
	});
});

// ─── EditTool runtime synchronization ────────────────────────────────────────

describe("EditTool automatic routing", () => {
	function makeToolSession(getModel: () => string | undefined): ToolSession {
		return {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			enableLsp: false,
			settings: Settings.isolated(),
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
			getActiveModelString: getModel,
		} as unknown as ToolSession;
	}

	test("model switches rebuild mode, schema, wire name, and grammar coherently", () => {
		let model: string | undefined = "anthropic/claude-sonnet-4-6";
		const tool = new EditTool(makeToolSession(() => model));

		expect(tool.mode).toBe("replace");
		expect(tool.customWireName).toBeUndefined();
		expect(tool.customFormat).toBeUndefined();
		const replaceParameters = tool.parameters;

		model = "openai/gpt-5.4";
		expect(tool.mode).toBe("apply_patch");
		expect(tool.customWireName).toBe("apply_patch");
		expect(tool.customFormat?.syntax).toBe("lark");
		expect(tool.parameters).not.toBe(replaceParameters);

		model = "minimax-code/minimax-m2.5";
		expect(tool.mode).toBe("hashline");
		expect(tool.customWireName).toBeUndefined();
		expect(tool.customFormat?.syntax).toBe("lark");

		model = "custom/company-code-model";
		expect(tool.mode).toBe("hashline");
	});

	test("explicit edit.mode pins the tool across model switches", () => {
		let model = "anthropic/claude-sonnet-4-6";
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			enableLsp: false,
			settings: Settings.isolated({ "edit.mode": "replace" }),
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
			getActiveModelString: () => model,
		} as unknown as ToolSession;
		const tool = new EditTool(session);
		expect(tool.mode).toBe("replace");
		model = "openai/gpt-5.4";
		expect(tool.mode).toBe("replace");
	});

	test("environment force pins the tool across model switches", () => {
		Bun.env.GJC_EDIT_VARIANT = "hashline";
		let model = "anthropic/claude-sonnet-4-6";
		const tool = new EditTool(makeToolSession(() => model));
		expect(tool.mode).toBe("hashline");
		model = "openai/gpt-5.4";
		expect(tool.mode).toBe("hashline");
	});

	test("invalid env variant fails fast at construction", () => {
		Bun.env.GJC_EDIT_VARIANT = "atom";
		expect(() => new EditTool(makeToolSession(() => undefined))).toThrow(/Invalid GJC_EDIT_VARIANT/);
	});
});
