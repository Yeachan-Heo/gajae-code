import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "@gajae-code/coding-agent/config/settings-schema";

describe("mcp.enableRuntimeServers setting", () => {
	it("exists in the TS settings schema and defaults to false", () => {
		const def = SETTINGS_SCHEMA["mcp.enableRuntimeServers"];
		expect(def).toBeDefined();
		expect(def.type).toBe("boolean");
		expect(def.default).toBe(false);
	});

	it("does not change the mcp.enableProjectConfig default (stays false)", () => {
		expect(SETTINGS_SCHEMA["mcp.enableProjectConfig"].default).toBe(false);
	});

	it("is exposed in the generated root JSON schema with default false", async () => {
		const schemaPath = path.resolve(import.meta.dir, "..", "..", "..", "schemas", "config.schema.json");
		const schema = JSON.parse(await Bun.file(schemaPath).text()) as {
			properties: { mcp: { properties: Record<string, { type?: string; default?: unknown }> } };
		};
		const mcp = schema.properties.mcp.properties;
		expect(mcp.enableRuntimeServers).toBeDefined();
		expect(mcp.enableRuntimeServers.type).toBe("boolean");
		expect(mcp.enableRuntimeServers.default).toBe(false);
		expect(mcp.enableProjectConfig.default).toBe(false);
	});
});
