import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { inspectConfigFile, runConfigCommand } from "../src/cli/config-cli";
import { FileLockTestHooks } from "../src/config/file-lock";
import { resetSettingsForTest, settings } from "../src/config/settings";

let testAgentDir = "";
const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	resetSettingsForTest();
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-config-cli-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

describe("config CLI schema coverage", () => {
	it("keeps locale selection JSON canonical and English-described", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "ui.language", value: "ko", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "ui.language", flags: { json: true } });

		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			key: "ui.language",
			value: "ko",
			type: "enum",
			description: "Language for human-facing interactive UI text",
		});

		await runConfigCommand({ action: "set", key: "ui.language", value: "ja", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "ui.language", flags: { json: true } });

		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			key: "ui.language",
			value: "ja",
			type: "enum",
			description: "Language for human-facing interactive UI text",
		});
	});

	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});

	it("parses and validates optional autorouting objects as JSON", async () => {
		const setup = '{"schema":1,"providers":["anthropic"]}';
		await runConfigCommand({ action: "set", key: "task.autorouting.setup", value: setup, flags: { json: true } });
		expect(settings.get("task.autorouting.setup")).toEqual({ schema: 1, providers: ["anthropic"] });
	});

	it("sets and gets deep-interview ambiguity threshold", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "gjc.deepInterview.ambiguityThreshold",
			value: "0.2",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "gjc.deepInterview.ambiguityThreshold", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		expect(JSON.parse(String(payload))).toMatchObject({
			key: "gjc.deepInterview.ambiguityThreshold",
			type: "number",
			value: 0.2,
		});
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const thresholdPayload = logSpy.mock.calls.at(-2)?.[0];
		const timeoutPayload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});

	it("reports invalid settings through config doctor JSON", async () => {
		await Bun.write(
			path.join(testAgentDir, "config.yml"),
			"configSchemaVersion: 2\nnotifications:\n  enabled: invalid\n",
		);
		resetSettingsForTest();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "doctor", flags: { json: true } });

		const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
			issues: Array<{ path: string; kind: string; detail: string }>;
		};
		expect(report.issues).toContainEqual({
			path: "notifications.enabled",
			kind: "invalid",
			detail: "Expected boolean.",
		});
	});

	describe("secret redaction", () => {
		it("redacts secret-like values in list, get, and set output by default", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const brokerSecret = "broker-token-secret-123";
			const apiSecret = "hindsight-api-token-secret-123";

			await runConfigCommand({
				action: "set",
				key: "auth.broker.token",
				value: brokerSecret,
				flags: { json: true },
			});
			await runConfigCommand({ action: "set", key: "hindsight.apiToken", value: apiSecret, flags: { json: true } });
			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true } });
			await runConfigCommand({ action: "list", flags: { json: true } });

			const setPayload = JSON.parse(String(logSpy.mock.calls.at(-4)?.[0])) as { value: unknown };
			const apiTokenSetPayload = JSON.parse(String(logSpy.mock.calls.at(-3)?.[0])) as { value: unknown };
			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, { value: unknown }>;

			expect(setPayload.value).toBe("<redacted>");
			expect(apiTokenSetPayload.value).toBe("<redacted>");
			expect(getPayload.value).toBe("<redacted>");
			expect(listPayload["auth.broker.token"]?.value).toBe("<redacted>");
			expect(listPayload["hindsight.apiToken"]?.value).toBe("<redacted>");
			expect(JSON.stringify(setPayload)).not.toContain(brokerSecret);
			expect(JSON.stringify(apiTokenSetPayload)).not.toContain(apiSecret);
			expect(JSON.stringify(getPayload)).not.toContain(brokerSecret);
			expect(JSON.stringify(listPayload)).not.toContain(brokerSecret);
			expect(JSON.stringify(listPayload)).not.toContain(apiSecret);
		});

		it("redacts non-string secret-like values from get and list JSON loaded from config", async () => {
			const configPath = path.join(testAgentDir, "config.yml");
			await Bun.write(
				configPath,
				[
					"auth:",
					"  broker:",
					"    token:",
					"      - broker-token-object-secret-123",
					"hindsight:",
					"  apiToken:",
					"    nested: hindsight-api-token-object-secret-123",
					"",
				].join("\n"),
			);
			resetSettingsForTest();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true } });
			await runConfigCommand({ action: "list", flags: { json: true } });

			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, { value: unknown }>;

			expect(getPayload.value).toBe("<redacted>");
			expect(listPayload["auth.broker.token"]?.value).toBe("<redacted>");
			expect(listPayload["hindsight.apiToken"]?.value).toBe("<redacted>");
			expect(JSON.stringify(getPayload)).not.toContain("broker-token-object-secret-123");
			expect(JSON.stringify(listPayload)).not.toContain("broker-token-object-secret-123");
			expect(JSON.stringify(listPayload)).not.toContain("hindsight-api-token-object-secret-123");
		});

		it("shows non-string secret-like values with the explicit unsafe opt-in", async () => {
			const configPath = path.join(testAgentDir, "config.yml");
			await Bun.write(
				configPath,
				[
					"auth:",
					"  broker:",
					"    token:",
					"      - broker-token-array-secret-456",
					"hindsight:",
					"  apiToken:",
					"    nested: hindsight-api-token-object-secret-456",
					"",
				].join("\n"),
			);
			resetSettingsForTest();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true, showSecrets: true } });
			await runConfigCommand({ action: "list", flags: { json: true, showSecrets: true } });

			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, { value: unknown }>;

			expect(getPayload.value).toEqual(["broker-token-array-secret-456"]);
			expect(listPayload["auth.broker.token"]?.value).toEqual(["broker-token-array-secret-456"]);
			expect(listPayload["hindsight.apiToken"]?.value).toEqual({ nested: "hindsight-api-token-object-secret-456" });
		});

		it("keeps non-secret booleans visible while redacting secret-shaped keys in text output", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const secret = "telegram-token-secret-456";

			await runConfigCommand({
				action: "set",
				key: "notifications.telegram.botToken",
				value: secret,
				flags: { json: true },
			});
			await runConfigCommand({ action: "set", key: "notifications.enabled", value: "true", flags: { json: true } });
			await runConfigCommand({ action: "get", key: "notifications.enabled", flags: {} });
			const enabledGet = Bun.stripANSI(String(logSpy.mock.calls.at(-1)?.[0]));
			await runConfigCommand({ action: "list", flags: {} });

			const listOutput = logSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");

			expect(enabledGet).toBe("true");
			expect(listOutput).toContain("notifications.enabled = true");
			expect(listOutput).toContain("notifications.telegram.botToken = <redacted>");
			expect(listOutput).not.toContain(secret);
		});

		it("shows secret-like values only with the explicit unsafe opt-in", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const secret = "broker-token-secret-789";

			await runConfigCommand({
				action: "set",
				key: "auth.broker.token",
				value: secret,
				flags: { json: true, showSecrets: true },
			});
			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true, showSecrets: true } });

			const setPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as { value: unknown };

			expect(setPayload.value).toBe(secret);
			expect(getPayload.value).toBe(secret);
		});
	});
});

describe("config doctor vendor-separated delegation advisory", () => {
	const vendorSeparatedRoles = [
		"configSchemaVersion: 2",
		"modelRoles:",
		"  default: anthropic/claude-opus-5:medium",
		"task:",
		"  agentModelOverrides:",
		"    executor: openai-codex/gpt-5.5:high",
	];

	async function doctorAdvisories(configLines: string[]): Promise<string[]> {
		await Bun.write(path.join(testAgentDir, "config.yml"), `${configLines.join("\n")}\n`);
		resetSettingsForTest();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({ action: "doctor", flags: { json: true } });
		return (JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as { advisories: string[] }).advisories;
	}

	it("warns when an explicit task.eager false leaves vendor-separated workers unused", async () => {
		const advisories = await doctorAdvisories([...vendorSeparatedRoles, "  eager: false"]);
		expect(advisories).toHaveLength(1);
		expect(String(advisories[0])).toContain("executor");
		expect(String(advisories[0])).toContain("task.eager true");
	});

	it("stays silent when vendor separation already implies delegation", async () => {
		expect(await doctorAdvisories(vendorSeparatedRoles)).toEqual([]);
	});

	it("stays silent for a single-vendor layout with task.eager false", async () => {
		expect(
			await doctorAdvisories([
				"configSchemaVersion: 2",
				"modelRoles:",
				"  default: openai-codex/gpt-5.6-sol:low",
				"task:",
				"  eager: false",
				"  agentModelOverrides:",
				"    executor: openai-codex/gpt-5.6-terra:low",
			]),
		).toEqual([]);
	});
});

describe("config doctor", () => {
	it("reports typoed settings from a fixture config", async () => {
		const configPath = path.join(testAgentDir, "config.yml");
		await fs.writeFile(configPath, "compaction:\n  enabled: true\n  enabld: false\n");
		const report = await inspectConfigFile(configPath);
		expect(report.unknownKeys).toContain("compaction.enabld");
	});
});

it("redacts invalid secret settings in doctor output", async () => {
	const configPath = path.join(testAgentDir, "config.yml");
	const secret = "doctor-secret-token";
	await fs.writeFile(configPath, `notifications:\n  telegram:\n    botToken: [${secret}]\n`);

	const report = await inspectConfigFile(configPath);
	expect(report.invalidValues).toContainEqual({ path: "notifications.telegram.botToken", value: "<redacted>" });
	expect(JSON.stringify(report)).not.toContain(secret);
});

describe("config CLI durable persistence", () => {
	// `settings.set` only mutates the in-memory view; the durable write runs in the
	// background. A mutating command that reports from that view claims success even when
	// config.yml was never updated -- which is the normal outcome wherever the durable save
	// is refused (on NFS the native exact replacement reports `atomic_unavailable` and the
	// config writer declines a fallback). The command must fail loudly, because a success
	// line for a setting that silently reverts on the next process is worse than an error.
	it("fails the set command when the setting cannot be persisted", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
			throw new Error("process.exit");
		}) as never);
		// Load settings (and open the settings database) first, then revoke write access to
		// the agent directory so only the durable config.yml replace fails: the atomic write
		// stages a sibling temp file, which an unwritable directory refuses.
		await runConfigCommand({ action: "get", key: "colorBlindMode", flags: { json: true } });
		await fs.chmod(testAgentDir, 0o500);

		try {
			await expect(
				runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } }),
			).rejects.toThrow("process.exit");
		} finally {
			await fs.chmod(testAgentDir, 0o700);
		}

		expect(exitSpy).toHaveBeenCalledWith(1);
		const errors = errorSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? "")));
		expect(errors.some(line => line.includes("Failed to persist setting"))).toBe(true);
		const diagnostic = errors.join("\n");
		expect(diagnostic).toMatch(/EACCES|atomic replacement failed|atomic_unavailable/);
		expect(diagnostic).not.toContain(testAgentDir);
		expect(diagnostic).not.toContain("true");
		const logs = logSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? "")));
		expect(logs.some(line => line.includes('"value": true') || line.includes('"value":true'))).toBe(false);
	});

	it("writes the value to config.yml before reporting success", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } });

		const contents = await fs.readFile(path.join(testAgentDir, "config.yml"), "utf8");
		expect(contents).toContain("colorBlindMode");
		const logs = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		expect(logs.some(line => line.includes('"colorBlindMode"'))).toBe(true);
	});

	it("durably saves reset before reporting success", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } });
		logSpy.mockClear();
		await runConfigCommand({ action: "reset", key: "colorBlindMode", flags: { json: true } });

		const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as { key: string; value: unknown };
		expect(payload).toEqual({ key: "colorBlindMode", value: false });
		const persisted = YAML.parse(await fs.readFile(path.join(testAgentDir, "config.yml"), "utf8")) as {
			colorBlindMode?: unknown;
		};
		expect(persisted.colorBlindMode).toBe(false);
	});

	it("fails reset without success output when the durable save is denied", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
			throw new Error("process.exit");
		}) as never);

		await runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } });
		logSpy.mockClear();
		await fs.chmod(testAgentDir, 0o500);

		try {
			await expect(
				runConfigCommand({ action: "reset", key: "colorBlindMode", flags: { json: true } }),
			).rejects.toThrow("process.exit");
		} finally {
			await fs.chmod(testAgentDir, 0o700);
		}

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain("Failed to persist setting");
	});

	it("does not retry a retargeted config save onto the new symlink target", async () => {
		const realTarget = path.join(testAgentDir, "real-config.yml");
		const otherTarget = path.join(testAgentDir, "other-config.yml");
		const configPath = path.join(testAgentDir, "config.yml");
		const initialConfig = "configSchemaVersion: 2\ncolorBlindMode: false\n";
		await fs.writeFile(realTarget, initialConfig, "utf8");
		await fs.writeFile(otherTarget, initialConfig, "utf8");
		await fs.symlink(realTarget, configPath);
		resetSettingsForTest();

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({ action: "get", key: "colorBlindMode", flags: { json: true } });
		logSpy.mockClear();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
			throw new Error("process.exit");
		}) as never);
		const originalHook = FileLockTestHooks.afterParentMkdir;
		let retargeted = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (retargeted || !lockPath.endsWith("real-config.yml.lock")) return;
			retargeted = true;
			await fs.rm(configPath, { force: true });
			await fs.symlink(otherTarget, configPath);
		};

		try {
			await expect(
				runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } }),
			).rejects.toThrow("process.exit");
		} finally {
			FileLockTestHooks.afterParentMkdir = originalHook;
		}

		expect(retargeted).toBe(true);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(await fs.readFile(realTarget, "utf8")).toBe(initialConfig);
		expect(await fs.readFile(otherTarget, "utf8")).toBe(initialConfig);
		const diagnostic = errorSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");
		expect(diagnostic).toContain("config target changed during save");
		expect(diagnostic).not.toContain(testAgentDir);
	});
});
