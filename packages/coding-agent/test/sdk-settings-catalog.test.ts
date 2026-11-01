import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getSettingsCatalog, type SettingCatalogItem, type SettingsCatalog } from "@gajae-code/coding-agent/sdk";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";
import { SETTINGS_SCHEMA, type SettingPath, Settings } from "../src/config/settings";

const temps: TempDir[] = [];
afterEach(() => {
	for (const temp of temps.splice(0)) temp.removeSync();
});

function item(catalog: SettingsCatalog, settingPath: SettingPath): SettingCatalogItem {
	const found = catalog.items.find(entry => entry.path === settingPath);
	if (!found) throw new Error(`Missing catalog path ${settingPath}`);
	return found;
}

describe("portable settings catalog", () => {
	it("reports effective scalar precedence including same-value runtime intent without asserting durability", async () => {
		const temp = TempDir.createSync("@gjc-settings-catalog-");
		temps.push(temp);
		const cwd = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		await Bun.write(path.join(agentDir, "config.yml"), "temperature: 0.2\nui:\n  language: en\n");
		await Bun.write(path.join(getProjectAgentDir(cwd), "config.yml"), "temperature: 0.6\nui:\n  language: ko\n");
		const settings = await Settings.loadForScope({ cwd, agentDir });
		expect(item(getSettingsCatalog(settings), "temperature")).toMatchObject({
			effectiveValue: { status: "available", value: 0.6 },
			resolution: {
				origin: "project",
				layers: ["global", "project"],
				allowedLayers: ["global", "project", "runtime"],
			},
			application: { kind: "next-run" },
		});
		settings.override("temperature", 0.6);
		expect(item(getSettingsCatalog(settings), "temperature").resolution).toMatchObject({
			origin: "runtime",
			layers: ["global", "project", "runtime"],
		});
		settings.clearOverride("temperature");
		expect(item(getSettingsCatalog(settings), "temperature").resolution.origin).toBe("project");
		settings.override("ui.language", "ko");
		expect(item(getSettingsCatalog(settings), "ui.language")).toMatchObject({
			effectiveValue: { status: "available", value: "en" },
			resolution: { origin: "global", layers: ["global"], allowedLayers: ["global"] },
		});
		expect(getSettingsCatalog(settings).durableStorage).toBe(true);
	});

	for (const shadow of [null, [], 17]) {
		it(`tracks ancestor replacement by ${JSON.stringify(shadow)} through the real merge`, async () => {
			const temp = TempDir.createSync("@gjc-catalog-ancestor-");
			temps.push(temp);
			const cwd = path.join(temp.path(), "project");
			const agentDir = path.join(temp.path(), "agent");
			await Bun.write(
				path.join(agentDir, "config.yml"),
				JSON.stringify({
					lsp: { enabled: false },
					statusLine: { segmentOptions: { global: { value: true } } },
				}),
			);
			await Bun.write(
				path.join(getProjectAgentDir(cwd), "config.yml"),
				JSON.stringify({ lsp: shadow, statusLine: shadow }),
			);
			const settings = await Settings.loadForScope({ cwd, agentDir });
			try {
				expect(settings.get("lsp.enabled")).toBe(true);
				expect(item(getSettingsCatalog(settings), "lsp.enabled")).toMatchObject({
					effectiveValue: { status: "available", value: true },
					resolution: { origin: "default", layers: ["global"] },
				});
				settings.override("statusLine.segmentOptions", { runtime: { value: true } });
				expect(settings.get("statusLine.segmentOptions")).toEqual({ runtime: { value: true } });
				expect(item(getSettingsCatalog(settings), "statusLine.segmentOptions").resolution).toMatchObject({
					origin: "runtime",
					layers: ["global", "runtime"],
				});
			} finally {
				await settings.close();
			}
		});
	}

	it("withholds free-form strings, structured values and suspicious paths instead of key-only redaction", () => {
		const secret = "catalog-must-not-leak-credential";
		const settings = Settings.isolated({
			"auth.broker.token": secret,
			"auth.credentialPins": { provider: secret },
			"theme.dark": secret,
			"hindsight.apiUrl": `https://user:${secret}@example.com`,
			modelRoles: { default: secret },
			temperature: secret as never,
		});
		const catalog = getSettingsCatalog(settings);
		expect(JSON.stringify(catalog)).not.toContain(secret);
		expect(item(catalog, "auth.broker.token").effectiveValue).toEqual({
			status: "withheld",
			reason: "sensitive-path",
		});
		expect(item(catalog, "theme.dark").effectiveValue).toEqual({ status: "withheld", reason: "free-form" });
		expect(item(catalog, "modelRoles").effectiveValue).toEqual({ status: "withheld", reason: "structured" });
		expect(item(catalog, "temperature").effectiveValue).toEqual({ status: "withheld", reason: "invalid" });
		expect(catalog.durableStorage).toBe(false);
	});

	it("keeps runtime choices and unaudited application semantics explicit, and snapshots detached", () => {
		const settings = Settings.isolated({ temperature: 0.3 });
		const first = getSettingsCatalog(settings);
		expect(first.items.map((entry): string => entry.path).sort()).toEqual(Object.keys(SETTINGS_SCHEMA).sort());
		const theme = item(first, "theme.dark");
		expect(theme.choices).toEqual({ source: "runtime", status: "host-required" });
		expect(theme.application).toEqual({ kind: "unclassified" });
		expect(theme.mutation).toEqual({ provided: false, owner: "unspecified" });
		if (!theme.ui) throw new Error("Missing theme metadata");
		theme.ui.label = "changed by renderer";
		theme.resolution.allowedLayers.length = 0;
		settings.set("temperature", 0.9);
		expect(item(first, "temperature").effectiveValue).toEqual({ status: "available", value: 0.3 });
		const second = getSettingsCatalog(settings);
		expect(item(second, "temperature").effectiveValue).toEqual({ status: "available", value: 0.9 });
		expect(item(second, "theme.dark").ui?.label).not.toBe("changed by renderer");
		expect(item(second, "theme.dark").resolution.allowedLayers).toEqual(["global", "project", "runtime"]);
	});

	it("describes layered objects without claiming per-leaf origin or mutation permissions", () => {
		const settings = Settings.isolated(
			{ modelRoles: { default: "global/model" } },
			{
				overrides: { modelRoles: { smol: "runtime/model" } },
			},
		);
		expect(item(getSettingsCatalog(settings), "modelRoles")).toMatchObject({
			resolution: { origin: "layered", layers: ["global", "runtime"] },
			effectiveValue: { status: "withheld", reason: "structured" },
			mutation: { provided: false },
		});
		expect(item(getSettingsCatalog(settings), "notifications.telegram.chatId").resolution.allowedLayers).toEqual([
			"global",
		]);
	});
});
