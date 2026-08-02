import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	configBatchWriteHandler,
	configReadHandler,
	configValueWriteHandler,
	modelConfigHandlers,
	modelListHandler,
	modelProviderCapabilitiesReadHandler,
} from "../../suites/model-config-handlers";

const agentDir = mkdtempSync(path.join(os.tmpdir(), "gjc-model-config-suite-"));
const previousAgentDir = process.env.GJC_AGENT_DIR;

beforeAll(() => {
	process.env.GJC_AGENT_DIR = agentDir;
	writeFileSync(
		path.join(agentDir, "models.yml"),
		YAML.stringify(
			{
				providers: {
					fixture: {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [
							{
								id: "fixture-model",
								name: "Fixture Model",
								reasoning: false,
								input: ["text"],
								contextWindow: 4096,
								maxTokens: 1024,
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function resultOf(value: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

test("model/list enumerates a model loaded from the temp models config", async () => {
	const result = await modelListHandler({ includeHidden: true });
	expect(result.ok).toBe(true);
	const payload = resultOf(result) as { data: Array<Record<string, unknown>>; nextCursor: string | null };
	const fixture = payload.data.find(model => model.id === "fixture/fixture-model");
	expect(fixture).toBeDefined();
	expect(fixture?.displayName).toBe("Fixture Model");
	expect(fixture?.model).toBe("fixture-model");
	expect(payload.nextCursor).toBeNull();
	expect(stableValidators.clientRequestResults["model/list"]?.(payload)).toBe(true);
});

test("modelProvider/capabilities/read derives model compatibility and rejects an unknown provider", async () => {
	const result = await modelProviderCapabilitiesReadHandler({ provider: "fixture", model: "fixture-model" });
	expect(result.ok).toBe(true);
	const payload = resultOf(result) as Record<string, unknown>;
	expect(payload.provider).toBe("fixture");
	expect(payload.model).toBe("fixture-model");
	expect(payload.contextWindow).toBe(4096);
	expect(payload.maxTokens).toBe(1024);
	expect(typeof payload.namespaceTools).toBe("boolean");
	expect(stableValidators.clientRequestResults["modelProvider/capabilities/read"]?.(payload)).toBe(true);
	expect(await modelProviderCapabilitiesReadHandler({ provider: "missing-provider" })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
});

test("config/value/write persists through Settings and config/read observes the value", async () => {
	const before = resultOf(await configReadHandler({ includeLayers: true })) as Record<string, unknown>;
	const beforeConfig = before.config as Record<string, unknown>;
	const beforeDesktop = beforeConfig.desktop as Record<string, unknown>;
	expect((beforeDesktop.display as Record<string, unknown>).tabWidth).toBe(3);

	const written = await configValueWriteHandler({
		keyPath: "display.tabWidth",
		value: 7,
		mergeStrategy: "replace",
	});
	expect(written.ok).toBe(true);
	if (written.ok) expect(stableValidators.clientRequestResults["config/value/write"]?.(written.result)).toBe(true);
	expect(readFileSync(path.join(agentDir, "config.yml"), "utf8")).toContain("tabWidth: 7");

	const after = resultOf(await configReadHandler({ includeLayers: true })) as Record<string, unknown>;
	const afterDesktop = (after.config as Record<string, unknown>).desktop as Record<string, unknown>;
	expect((afterDesktop.display as Record<string, unknown>).tabWidth).toBe(7);
	expect(stableValidators.clientRequestResults["config/read"]?.(after)).toBe(true);
});

test("config writes reject unknown and invalid values without mutating the config", async () => {
	const unknown = await configValueWriteHandler({ keyPath: "does.not.exist", value: true, mergeStrategy: "replace" });
	expect(unknown).toEqual({ ok: false, errorKey: "invalidParams" });
	const invalid = await configValueWriteHandler({
		keyPath: "display.tabWidth",
		value: "wide",
		mergeStrategy: "replace",
	});
	expect(invalid).toEqual({ ok: false, errorKey: "invalidParams" });

	const before = resultOf(await configReadHandler({})) as Record<string, unknown>;
	const beforeDesktop = ((before.config as Record<string, unknown>).desktop as Record<string, unknown>)
		.display as Record<string, unknown>;
	expect(beforeDesktop.tabWidth).toBe(7);

	const batch = await configBatchWriteHandler({
		edits: [
			{ keyPath: "display.tabWidth", value: 9, mergeStrategy: "replace" },
			{ keyPath: "does.not.exist", value: true, mergeStrategy: "replace" },
		],
		reloadUserConfig: true,
	});
	expect(batch).toEqual({ ok: false, errorKey: "invalidParams" });
	const after = resultOf(await configReadHandler({})) as Record<string, unknown>;
	const afterDesktop = ((after.config as Record<string, unknown>).desktop as Record<string, unknown>)
		.display as Record<string, unknown>;
	expect(afterDesktop.tabWidth).toBe(7);
});

test("the modelConfig lane exposes exactly the methods GJC can back", () => {
	expect(Object.keys(modelConfigHandlers).sort()).toEqual([
		"config/batchWrite",
		"config/read",
		"config/value/write",
		"model/list",
		"modelProvider/capabilities/read",
	]);
});
