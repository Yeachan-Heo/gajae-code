import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { defineCapability, getCapability, registerProvider } from "../../src/capability";
import type { LoadContext, LoadResult, Provider } from "../../src/capability/types";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";

interface TestItem {
	name: string;
}

function provider(id: string, displayName: string, priority: number): Provider<TestItem> {
	return {
		id,
		displayName,
		description: `${displayName} description`,
		priority,
		load: (_ctx: LoadContext): Promise<LoadResult<TestItem>> => Promise.resolve({ items: [{ name: displayName }] }),
	};
}

describe("standalone MCP settings", () => {
	test("exposes mcp.enableStandalone as a config-only default-false boolean setting", () => {
		const setting = SETTINGS_SCHEMA["mcp.enableStandalone"];

		expect(setting.type).toBe("boolean");
		expect(setting.default).toBe(false);
		expect(Object.hasOwn(setting, "ui")).toBe(false);
	});

	test("keeps config JSON schema in sync with additionalProperties locked down", async () => {
		const schema = await Bun.file(`${import.meta.dir}/../../../../schemas/config.schema.json`).json();
		const mcp = schema.properties.mcp;
		const enableStandalone = mcp.properties.enableStandalone;

		expect(enableStandalone.type).toBe("boolean");
		expect(enableStandalone.default).toBe(false);
		expect(mcp.additionalProperties).toBe(false);
	});
});

describe("capability provider registration", () => {
	test("keeps the first provider when a duplicate provider id registers for the same capability", () => {
		const capabilityId = `standalone-mcp-duplicate-provider-${randomUUID()}`;
		defineCapability<TestItem>({
			id: capabilityId,
			displayName: "Standalone MCP duplicate provider test",
			description: "Test-only capability for duplicate provider registration",
			key: item => item.name,
		});

		const first = provider("duplicate-provider", "First provider", 10);
		const second = provider("duplicate-provider", "Second provider", 100);

		registerProvider(capabilityId, first);
		registerProvider(capabilityId, second);

		const capability = getCapability<TestItem>(capabilityId);
		expect(capability?.providers).toHaveLength(1);
		expect(capability?.providers[0]).toBe(first);
		expect(capability?.providers[0]?.displayName).toBe("First provider");
	});
});
