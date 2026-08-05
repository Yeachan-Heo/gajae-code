import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import {
	extractWorkflowSetting,
	resolveWorkflowSetting,
	WorkflowSettingError,
	type WorkflowSettingKey,
} from "../../src/gjc-runtime/workflow-settings";

const KEY: WorkflowSettingKey = "gjc.ralplan.maxIterations";
const PROBE = path.join(import.meta.dir, "../fixtures/workflow-settings-probe.ts");

const stringParse = (value: unknown) =>
	typeof value === "string"
		? { kind: "valid" as const, value }
		: { kind: "invalid" as const, reason: "expected string" };

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workflow-settings-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function writeProjectSettings(cwd: string, document: unknown): Promise<string> {
	const projectDir = path.join(cwd, ".gjc");
	await fs.mkdir(projectDir, { recursive: true });
	const settingsPath = path.join(projectDir, "settings.json");
	await fs.writeFile(settingsPath, JSON.stringify(document, null, 2));
	return settingsPath;
}

async function writeProjectConfig(cwd: string, document: unknown): Promise<string> {
	const projectDir = path.join(cwd, ".gjc");
	await fs.mkdir(projectDir, { recursive: true });
	const configPath = path.join(projectDir, "config.yml");
	await fs.writeFile(configPath, YAML.stringify(document, null, 2));
	return configPath;
}

async function resolveIn(
	cwd: string,
	env: Record<string, string | undefined>,
	key: string = KEY,
): Promise<{ value: unknown; source: string; diagnostics: unknown[] }> {
	const proc = Bun.spawn([process.execPath, PROBE, key], {
		cwd,
		env: {
			...process.env,
			// Child probes must not inherit a runner's custom agent profile;
			// individual tests opt in explicitly when that behavior is under test.
			GJC_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_DIR: undefined,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${err}`);
	return JSON.parse(out.trim()) as { value: unknown; source: string; diagnostics: unknown[] };
}

describe("workflow-settings resolver", () => {
	test("project .gjc/settings.json wins over the built-in default", async () => {
		const cwd = await tempDir();
		// A non-numeric string is preserved (no schema number coercion applies).
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": "seven" });

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("seven");
		expect(result.source).toBe(path.join(cwd, ".gjc", "settings.json"));
	});

	test("project .gjc/config.yml beats project .gjc/settings.json", async () => {
		const cwd = await tempDir();
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: "yaml-wins" } } });
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": "json-loses" });

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("yaml-wins");
		expect(result.source).toBe(path.join(cwd, ".gjc", "config.yml"));
	});

	test("flat dotted and nested shapes are both extracted, flat wins", async () => {
		expect(extractWorkflowSetting({ "gjc.ralplan.maxIterations": 7 }, KEY)).toEqual({ present: true, value: 7 });
		expect(extractWorkflowSetting({ gjc: { ralplan: { maxIterations: 8 } } }, KEY)).toEqual({
			present: true,
			value: 8,
		});
		expect(
			extractWorkflowSetting({ "gjc.ralplan.maxIterations": 7, gjc: { ralplan: { maxIterations: 8 } } }, KEY),
		).toEqual({
			present: true,
			value: 7,
		});
		expect(extractWorkflowSetting({ ralplan: { maxIterations: 9 } }, KEY)).toEqual({
			present: false,
			value: undefined,
		});
		expect(extractWorkflowSetting({ gjc: { other: 1 } }, KEY)).toEqual({ present: false, value: undefined });
		expect(extractWorkflowSetting("not-an-object", KEY)).toEqual({ present: false, value: undefined });
	});

	test("empty documents continue; a null root is a malformed shape (strict throws)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), "", "utf8"); // empty YAML -> no explicit settings
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "null", "utf8"); // JSON null root -> malformed

		// tolerant: the empty document continues, the null root is an invalid shape
		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");
		expect(result.diagnostics.map(d => d.status)).toContain("empty-document");
		expect(result.diagnostics.map(d => d.status)).toContain("invalid");
		// strict: the malformed explicit layer must fail closed (exit 2 contract)
		await expect(
			resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse, invalidPolicy: "throw" }),
		).rejects.toThrow();
	});

	test("the literal JSON text undefined is malformed (strict throws, tolerant continues)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "undefined", "utf8");

		// Strict: fail closed (exit 2) on the malformed explicit JSON layer.
		await expect(
			resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse, invalidPolicy: "throw" }),
		).rejects.toThrow();
		// Tolerant: continue with an invalid diagnostic (not empty-document).
		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.diagnostics.map(d => d.status)).not.toContain("empty-document");
		expect(result.diagnostics.map(d => d.status)).toContain("invalid");
	});

	test("scalar and array roots are invalid shape, continue by default", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify(["a", "b"]), "utf8");

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.diagnostics.map(d => d.status)).toContain("invalid");
	});

	test("malformed JSON is invalid syntax, continue by default, throw under strict", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "{ broken json", "utf8");

		const continued = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(continued.value).toBe("default");
		expect(continued.diagnostics.find(d => d.layer === "project-settings")?.classification).toBe("syntax");

		const thrown = await resolveWorkflowSetting(cwd, KEY, {
			defaultValue: "default",
			parse: stringParse,
			invalidPolicy: "throw",
		}).catch(error => error);
		expect(thrown).toBeInstanceOf(WorkflowSettingError);
		expect(thrown.path).toBe(path.join(cwd, ".gjc", "settings.json"));
		expect(thrown.classification).toBe("syntax");
		expect(thrown.layer).toBe("project-settings");
		expect(thrown.message).toContain("invalid workflow setting at");
	});

	test("an invalid present value is invalid/value, continue by default, throw under strict", async () => {
		const cwd = await tempDir();
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": 7 });

		const continued = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(continued.value).toBe("default");
		expect(continued.diagnostics.find(d => d.layer === "project-settings")?.classification).toBe("value");

		const thrown = await resolveWorkflowSetting(cwd, KEY, {
			defaultValue: "default",
			parse: stringParse,
			invalidPolicy: "throw",
		}).catch(error => error);
		expect(thrown).toBeInstanceOf(WorkflowSettingError);
		expect(thrown.classification).toBe("value");
		expect(thrown.reason).toBe("expected string");
	});

	test("agent config.yml (GJC_CODING_AGENT_DIR) beats the legacy config-root settings.json", async () => {
		const home = await tempDir();
		const agentDir = await tempDir();
		const cwd = await tempDir();
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "agent" } } }, null, 2),
		);
		await fs.mkdir(path.join(home, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".gjc", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "root" }),
		);

		const result = await resolveIn(cwd, {
			HOME: home,
			GJC_CODING_AGENT_DIR: agentDir,
		});
		expect(result.value).toBe("agent");
		expect(result.source).toBe(path.join(agentDir, "config.yml"));
	});
	test("flat keys are honored only in legacy JSON settings, not config.yml", async () => {
		const cwd = await tempDir();
		// config.yml carries only a flat dotted key: it must be IGNORED (the
		// nested schema form is the config.yml format), so the nested JSON value
		// in settings.json wins.
		await writeProjectConfig(cwd, { "gjc.ralplan.maxIterations": "yaml-flat-ignored" });
		await writeProjectSettings(cwd, { gjc: { ralplan: { maxIterations: "json-nested" } } });

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("json-nested");
		expect(result.source).toBe(path.join(cwd, ".gjc", "settings.json"));
	});
	test("a quoted numeric config.yml value is coerced like the Settings schema", async () => {
		const cwd = await tempDir();
		// Nested config.yml with a quoted number: reconcileSettingsSchema coerces
		// numeric strings for number settings, and the resolver must match it.
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: "7" } } });
		const numberParse = (value: unknown) =>
			typeof value === "number"
				? { kind: "valid" as const, value }
				: { kind: "invalid" as const, reason: "not a number" };

		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: 5, parse: numberParse });
		expect(result.value).toBe(7);
		expect(result.source).toBe(path.join(cwd, ".gjc", "config.yml"));
	});

	test("the legacy config-root settings.json is the last fallback before default", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "root" }),
		);

		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe("root");
		expect(result.source).toBe(path.join(home, ".myconfig", "settings.json"));
	});
	test("a completed migration deactivates only the unchanged migrated source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		const source = path.join(home, ".myconfig", "settings.json");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": "root" });
		await fs.writeFile(source, sourceRaw);
		// A completed one-time migration marker for this exact source, with the
		// matching source hash (the migrated bytes).
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(home, ".myconfig", "agent", "config.yml"),
				sourceSha256: createHash("sha256").update(sourceRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		// While the source is still the migrated file, the layer is deactivated.
		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe("default");
		expect(result.source).toBe("default");

		// A later edit of the legacy file REACTIVATES the documented fallback.
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": "edited" }));
		const result2 = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result2.value).toBe("edited");
		expect(result2.source).toBe(source);

		// A CUSTOM agentDir profile never received the migrated value, so the
		// legacy layer stays active for it (no deactivation by target mismatch).
		const customAgent = await tempDir();
		const result3 = await resolveIn(cwd, {
			HOME: home,
			GJC_CONFIG_DIR: ".myconfig",
			GJC_CODING_AGENT_DIR: customAgent,
		});
		expect(result3.value).toBe("edited"); // the legacy fallback still works for the custom profile
		expect(result3.source).toBe(source);
	});
	test("a future-version migration marker does not deactivate the legacy source", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		const source = path.join(home, ".myconfig", "settings.json");
		const sourceRaw = JSON.stringify({ "gjc.ralplan.maxIterations": "root" });
		await fs.writeFile(source, sourceRaw);
		// A marker from a NEWER GJC version: the resolver must not treat the
		// migration as complete (the Settings migration would quarantine it).
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 999,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(home, ".myconfig", "agent", "config.yml"),
				sourceSha256: createHash("sha256").update(sourceRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe("root"); // legacy fallback stays active
		expect(result.source).toBe(source);
	});

	test("full five-layer precedence resolves the topmost project config.yml", async () => {
		const home = await tempDir();
		const agentDir = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await writeProjectConfig(cwd, { gjc: { ralplan: { maxIterations: "project-yaml" } } });
		await writeProjectSettings(cwd, { "gjc.ralplan.maxIterations": "project-json" });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: "agent" } } }, null, 2),
		);
		await fs.writeFile(
			path.join(home, ".myconfig", "settings.json"),
			JSON.stringify({ "gjc.ralplan.maxIterations": "root" }),
		);

		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig", GJC_CODING_AGENT_DIR: agentDir });
		expect(result.value).toBe("project-yaml");
		expect(result.source).toBe(path.join(cwd, ".gjc", "config.yml"));
	});
	test("an empty settings.json is malformed JSON (strict throws, tolerant continues)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), "   ", "utf8"); // whitespace-only

		await expect(
			resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse, invalidPolicy: "throw" }),
		).rejects.toThrow();
		const result = await resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse });
		expect(result.value).toBe("default");
		expect(result.diagnostics.map(d => d.status)).not.toContain("empty-document");
	});

	test("a malformed parent mapping is an invalid shape (strict throws)", async () => {
		const cwd = await tempDir();
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gjc", "config.yml"), YAML.stringify({ gjc: { ralplan: [] } }, null, 2));

		await expect(
			resolveWorkflowSetting(cwd, KEY, { defaultValue: "default", parse: stringParse, invalidPolicy: "throw" }),
		).rejects.toThrow();
	});
	test("an edited legacy source outranks its stale migration-owned agent value", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.mkdir(path.join(home, ".myconfig", "agent"), { recursive: true });
		const source = path.join(home, ".myconfig", "settings.json");
		const oldRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		// The agent config holds the stale MIGRATION-WRITTEN value.
		await fs.writeFile(
			path.join(home, ".myconfig", "agent", "config.yml"),
			YAML.stringify({ gjc: { ralplan: { maxIterations: 7 } } }, null, 2),
		);
		await fs.writeFile(`${source}.bak`, JSON.stringify({ "gjc.ralplan.maxIterations": 7 })); // migration copy
		// The user EDITED the legacy source after completion.
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 9 }));
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(home, ".myconfig", "agent", "config.yml"),
				sourceSha256: createHash("sha256").update(oldRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		// Direct workflow resolution (no Settings.init) must honor the edit.
		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe(9);
		expect(result.source).toBe(source);
	});

	test("a malformed agent config.yml during stale-key inspection does not crash resolution", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		await fs.mkdir(path.join(home, ".myconfig"), { recursive: true });
		await fs.mkdir(path.join(home, ".myconfig", "agent"), { recursive: true });
		const source = path.join(home, ".myconfig", "settings.json");
		const oldRaw = JSON.stringify({ "gjc.ralplan.maxIterations": 7 });
		// The agent config is syntactically MALFORMED: the stale-key inspection
		// must not let the YAML syntax error escape and crash tolerant
		// resolution - it defers to the regular layer parser, which reports an
		// invalid diagnostic and continues to the edited legacy source.
		await fs.writeFile(path.join(home, ".myconfig", "agent", "config.yml"), "broken: [unclosed", "utf8");
		await fs.writeFile(`${source}.bak`, JSON.stringify({ "gjc.ralplan.maxIterations": 7 })); // migration copy
		// The user EDITED the legacy source after completion.
		await fs.writeFile(source, JSON.stringify({ "gjc.ralplan.maxIterations": 9 }));
		await fs.writeFile(
			`${source}.migrated`,
			JSON.stringify({
				version: 1,
				status: "complete",
				sourcePath: source,
				backupPath: `${source}.bak`,
				targetPath: path.join(home, ".myconfig", "agent", "config.yml"),
				sourceSha256: createHash("sha256").update(oldRaw).digest("hex"),
				migratedKeys: ["gjc.ralplan.maxIterations"],
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		);

		// Tolerant resolution continues past the malformed agent config to the
		// edited legacy source instead of throwing.
		const result = await resolveIn(cwd, { HOME: home, GJC_CONFIG_DIR: ".myconfig" });
		expect(result.value).toBe(9);
		expect(result.source).toBe(source);
	});
});
