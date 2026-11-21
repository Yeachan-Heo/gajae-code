import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "@babel/parser";

const root = path.resolve(import.meta.dir, "../../..");
const sdkImports = new Set([
	"@gajae-code/coding-agent/sdk",
	"@gajae-code/coding-agent/sdk/embedding",
	"@gajae-code/coding-agent/sdk/job-observation",
	"@gajae-code/coding-agent/sdk/settings-catalog",
	"@gajae-code/coding-agent/sdk/workflow-gates",
]);
// Process reentry only, never app control: the compiled SDK launches its own
// guardian/supervisor/runtime and broker using process.execPath (the host image).
// These exact imports are confined to entry.ts and exercised by worker-dispatch.
const bootstrapImports = new Set([
	"@gajae-code/coding-agent/cli",
	"@gajae-code/coding-agent/exec/bash-shell-worker-protocol",
	"@gajae-code/coding-agent/exec/bash-shell-guardian",
	"@gajae-code/coding-agent/exec/bash-shell-supervisor",
	"@gajae-code/coding-agent/exec/bash-shell-worker",
]);

function violations(source: string, file: string): string[] {
	const result: string[] = [];
	const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	const inspect = (specifier: string) => {
		const normalized = specifier.replaceAll("\\", "/");
		if (normalized === "@gajae-code/tui" || normalized.startsWith("@gajae-code/tui/")) {
			result.push(`${file}: terminal UI dependency ${specifier}`);
			return;
		}
		if (!normalized.includes("coding-agent")) return;
		if (sdkImports.has(normalized)) return;
		if (file === "packages/desktop-host/src/entry.ts" && bootstrapImports.has(normalized)) return;
		// Reuse the canonical worker compile inventory, not runtime internals.
		if (file === "packages/desktop/scripts/build-host.ts" && normalized === "../../coding-agent/scripts/compile-args")
			return;
		result.push(`${file}: non-public SDK import ${specifier}`);
	};
	const object = (value: unknown): Record<string, unknown> | undefined =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const literal = (value: unknown): void => {
		const node = object(value);
		if (node?.type === "StringLiteral" && typeof node.value === "string") inspect(node.value);
	};
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const node = object(value);
		if (!node) return;
		if (
			["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(
				String(node.type),
			)
		)
			literal(node.source);
		if (node.type === "TSImportType") literal(node.argument);
		const callee = object(node.callee);
		if (
			node.type === "CallExpression" &&
			(callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require")) &&
			Array.isArray(node.arguments)
		)
			literal(node.arguments[0]);
		for (const child of Object.values(node)) visit(child);
	};
	visit(ast);
	if (/\b(?:RpcClient|RpcSession|rpc_client|rpc-mode|rpc-client)\b|--mode[ =]+rpc/.test(source))
		result.push(`${file}: legacy RPC control path`);
	if (
		/\.(?:executeBash|executePython|runEphemeralTurn|captureBtwTurn|setSessionAgentModelSelection|setRuntimeApiKey)\s*\(/.test(
			source,
		)
	)
		result.push(`${file}: runtime execution bypasses SDK controls`);
	if (
		/\.(?:authStorage|settings|modelRegistry)\.(?:set|login|setApiKey|commitAtomicBatch|applyModelProfile|deleteModelProfile|refresh|refreshInBackground)\s*\(/.test(
			source,
		)
	)
		result.push(`${file}: direct mutable runtime resource bypasses SDK controls`);
	return result;
}

async function files(directory: string): Promise<string[]> {
	const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(entry => {
			const name = `${directory}/${entry.name}`;
			return entry.isDirectory() ? files(name) : Promise.resolve(/\.[cm]?[jt]sx?$/.test(name) ? [name] : []);
		}),
	);
	return nested.flat();
}

describe("desktop public SDK boundary", () => {
	test("rejects static, dynamic, type-only, relative internals and stale RPC clients", () => {
		for (const source of [
			'import { Settings } from "@gajae-code/coding-agent/config/settings";',
			'export * from "../../coding-agent/src/modes/runtime-init";',
			'const x = import("@gajae-code/coding-agent/modes/rpc/rpc-client");',
			'type T = import("@gajae-code/coding-agent/session/agent-session").AgentSession;',
			'const x = require("@gajae-code/coding-agent/cli");',
			'session.executeBash("pwd");',
		])
			expect(violations(source, "packages/desktop-host/src/control.ts").length).toBeGreaterThan(0);
		expect(
			violations(
				'import { createAgentSession } from "@gajae-code/coding-agent/sdk";',
				"packages/desktop-host/src/control.ts",
			),
		).toEqual([]);
		expect(
			violations('import { runCli } from "@gajae-code/coding-agent/cli";', "packages/desktop-host/src/entry.ts"),
		).toEqual([]);
	});

	test("production app adapters use only approved public SDK surfaces", async () => {
		const sources = (
			await Promise.all([
				files("packages/desktop-host/src"),
				files("packages/desktop/src"),
				files("packages/desktop/scripts"),
			])
		).flat();
		const results = await Promise.all(
			sources.map(async file => violations(await Bun.file(path.join(root, file)).text(), file)),
		);
		expect(results.flat()).toEqual([]);
	});
});
