import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import { buildToolNamespacesInfo, resolveCodeMode } from "../src/session/code-mode";
import { generateCodeModeDeclarations } from "../src/tools/code-mode-declarations";

const ENABLED = ["eval", "ask", "read", "bash", "edit", "checkpoint"];

describe("resolveCodeMode", () => {
	it("keeps the direct tool surface when off", () => {
		const result = resolveCodeMode({
			toolMode: "code_mode_only",
			setting: "off",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});

		expect(result.active).toBe(false);
		expect([...result.directToolNames]).toEqual(ENABLED);
	});

	it("auto activates only for catalog-approved models", () => {
		const approved = resolveCodeMode({
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		const ordinary = resolveCodeMode({
			setting: "auto",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});

		expect(approved.active).toBe(true);
		expect([...approved.directToolNames]).toEqual(["eval", "ask", "checkpoint"]);
		expect(ordinary.active).toBe(false);
	});

	it("on activates for any compatible model", () => {
		const result = resolveCodeMode({
			setting: "on",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});

		expect(result.active).toBe(true);
		expect([...result.directToolNames]).toEqual(["eval", "ask", "checkpoint"]);
	});

	it("fails closed when eval is missing or cannot provide the bridge", () => {
		expect(
			resolveCodeMode({
				setting: "on",
				enabledToolNames: ["read", "bash"],
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
		expect(
			resolveCodeMode({
				setting: "on",
				enabledToolNames: ENABLED,
				evalTransportAvailable: false,
			}).active,
		).toBe(false);
	});

	it("keeps configured direct tools only when they are enabled", () => {
		const result = resolveCodeMode({
			setting: "on",
			extraDirectTools: ["read", "not-enabled"],
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});

		expect(result.directToolNames.has("read")).toBe(true);
		expect(result.directToolNames.has("not-enabled")).toBe(false);
	});
});

describe("buildToolNamespacesInfo", () => {
	it("describes direct and eval-bridged tools using Codex namespace metadata", () => {
		const info = buildToolNamespacesInfo({
			tools: [
				{ name: "eval" },
				{ name: "edit", customWireName: "apply_patch" },
				{ name: "mcp__demo-search", mcpServerName: "demo", loadMode: "discoverable" },
			],
			directToolNames: new Set(["eval", "edit"]),
		});

		expect(info.functions.functions.eval).toMatchObject({
			name: "eval",
			direct: true,
			code_mode_name: "eval",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.apply_patch).toMatchObject({
			name: "apply_patch",
			direct: true,
			code_mode_name: "edit",
		});
		expect(info.functions.functions["mcp__demo-search"]).toMatchObject({
			direct: false,
			code_mode_name: "mcp__demo-search",
			deferred: true,
			source: { kind: "mcp", server_name: "demo" },
		});
	});
});

function declarationTool(name: string, parameters: AgentTool["parameters"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters,
		concurrency: "shared",
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as AgentTool;
}

describe("generateCodeModeDeclarations", () => {
	it("renders compact argument signatures from tool schemas", () => {
		const declarations = generateCodeModeDeclarations([
			declarationTool(
				"read",
				z.object({
					path: z.string(),
					mode: z.enum(["text", "binary"]).optional(),
					limit: z.number().optional(),
				}),
			),
			declarationTool("mcp__demo-search", z.object({ query: z.string() })),
		]);

		expect(declarations).toContain('read(args: { path: string; mode?: "text" | "binary"; limit?: number })');
		expect(declarations).toContain('"mcp__demo-search"(args: { query: string })');
	});
});
