import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import HermesCommand from "../src/commands/hermes";
import McpServeCommand from "../src/commands/mcp-serve";
import { HERMES_MCP_PROTOCOL_VERSION, HERMES_MCP_SERVER_NAME, HERMES_MCP_TOOL_NAMES } from "../src/hermes/contract";
import { createHermesSafetyPolicy } from "../src/hermes-mcp/safety";
import { createHermesMcpServer, handleHermesMcpRequest } from "../src/hermes-mcp/server";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hermes-mcp-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function runCommand(argv: string[]): Promise<string> {
	let output = "";
	const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new McpServeCommand(argv, { bin: "gjc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		writeSpy.mockRestore();
	}
}

async function runHermesCommand(argv: string[]): Promise<string> {
	let output = "";
	const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new HermesCommand(argv, { bin: "gjc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		writeSpy.mockRestore();
	}
}

afterEach(() => {
	process.stdout.write = ORIGINAL_STDOUT_WRITE;
});

describe("gjc mcp-serve hermes", () => {
	it("exposes a checkable Hermes MCP command and rejects unknown subcommands as JSON", async () => {
		const ok = JSON.parse(await runCommand(["hermes", "--check", "--json"]));
		expect(ok).toEqual({
			ok: true,
			server: { name: HERMES_MCP_SERVER_NAME, protocolVersion: HERMES_MCP_PROTOCOL_VERSION },
			readOnly: true,
			tools: [...HERMES_MCP_TOOL_NAMES],
		});

		const rejected = JSON.parse(await runCommand(["bogus", "--json"]));
		expect(rejected).toEqual({ ok: false, reason: "unknown_mcp_serve_subcommand", subcommand: "bogus" });
	});

	it("exposes the same Hermes contract through the read-only CLI adapter", async () => {
		const ok = JSON.parse(await runHermesCommand(["--json"]));
		expect(ok).toEqual({
			ok: true,
			server: { name: HERMES_MCP_SERVER_NAME, protocolVersion: HERMES_MCP_PROTOCOL_VERSION },
			readOnly: true,
			tools: [...HERMES_MCP_TOOL_NAMES],
		});

		const tools = JSON.parse(await runHermesCommand(["tools", "--json"]));
		expect(tools).toEqual({ ok: true, tools: [...HERMES_MCP_TOOL_NAMES] });
	});

	it("implements initialize, tools/list, and read-only mutating rejection", async () => {
		const env = { ...process.env, GJC_HERMES_MCP_REPO: "repo-a" };
		const initialize = await handleHermesMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, { env });
		expect(initialize).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {}, prompts: {}, resources: {} },
				serverInfo: { name: "gjc-hermes-mcp", version: expect.any(String) },
			},
		});

		const listed = await handleHermesMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { env });
		expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("gjc_hermes_report_status");
		const prompts = await handleHermesMcpRequest({ jsonrpc: "2.0", id: 20, method: "prompts/list" }, { env });
		expect(prompts.result.prompts).toEqual([]);

		const resources = await handleHermesMcpRequest({ jsonrpc: "2.0", id: 21, method: "resources/list" }, { env });
		expect(resources.result.resources).toEqual([]);

		const called = await handleHermesMcpRequest(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "gjc_hermes_start_session", arguments: { cwd: process.cwd(), allow_mutation: true } },
			},
			{ env },
		);
		const payload = JSON.parse(called.result.content[0].text);
		expect(payload).toEqual({ ok: false, reason: "hermes_mutation_class_disabled:sessions" });
	});

	it("requires startup mutation class and per-call allow_mutation for mutating tools", async () => {
		await withTempRoot(async root => {
			let created = false;
			const env = {
				...process.env,
				GJC_HERMES_MCP_WORKDIR_ROOTS: root,
				GJC_HERMES_MCP_ENABLE_MUTATION_CLASSES: "session",
			};
			const missingPerCall = await handleHermesMcpRequest(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "gjc_hermes_start_session", arguments: { cwd: root } },
				},
				{
					env,
					createSession: () => {
						created = true;
						return { name: "x", attached: false, windows: 1, panes: 1, bindings: "root", createdAt: "now" };
					},
				},
			);
			expect(JSON.parse(missingPerCall.result.content[0].text)).toEqual({
				ok: false,
				reason: "hermes_mutation_call_not_allowed:sessions",
			});

			const allowed = await handleHermesMcpRequest(
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "gjc_hermes_start_session", arguments: { cwd: root, allow_mutation: true } },
				},
				{
					env,
					createSession: () => {
						created = true;
						return { name: "x", attached: false, windows: 1, panes: 1, bindings: "root", createdAt: "now" };
					},
				},
			);
			expect(created).toBe(true);
			expect(JSON.parse(allowed.result.content[0].text)).toEqual({
				ok: true,
				session: {
					session_id: "x",
					name: "x",
					attached: false,
					windows: 1,
					panes: 1,
					bindings: "root",
					created_at: "now",
					createdAt: "now",
				},
			});
		});
	});

	it("canonicalizes workdir roots and rejects traversal plus symlink escapes", async () => {
		await withTempRoot(async root => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hermes-outside-"));
			try {
				const link = path.join(root, "escape");
				await fs.symlink(outside, link);
				const policy = await createHermesSafetyPolicy({
					env: { ...process.env, GJC_HERMES_MCP_WORKDIR_ROOTS: root },
				});
				expect(await policy.resolveWorkdir(path.join(root, "..", path.basename(root)))).toBe(root);
				await expect(policy.resolveWorkdir(path.join(root, "..", path.basename(outside)))).rejects.toThrow(
					"workdir_outside_allowed_roots",
				);
				await expect(policy.resolveWorkdir(link)).rejects.toThrow("workdir_outside_allowed_roots");
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
			}
		});
	});

	it("bounds artifact reads and denies unsafe roots", async () => {
		await withTempRoot(async root => {
			const artifact = path.join(root, "artifact.txt");
			await Bun.write(artifact, "🙂🙂abcdef");
			const byteCap = 5;
			const env = {
				...process.env,
				GJC_HERMES_MCP_WORKDIR_ROOTS: root,
				GJC_HERMES_MCP_ARTIFACT_MAX_BYTES: String(byteCap),
			};
			const server = await createHermesMcpServer({ env });
			const read = await server.callTool("gjc_hermes_read_artifact", { path: artifact });
			expect(read.ok).toBe(true);
			expect(read.path).toBe(artifact);
			expect(read.bytes).toBeLessThanOrEqual(byteCap);
			expect(read.truncated).toBe(true);
			expect(Buffer.byteLength(String(read.text))).toBeLessThanOrEqual(byteCap);
			await expect(
				server.callTool("gjc_hermes_read_artifact", { path: path.join(os.tmpdir(), "missing.txt") }),
			).resolves.toEqual({
				ok: false,
				reason: "artifact_outside_allowed_roots",
			});
		});
	});
});
