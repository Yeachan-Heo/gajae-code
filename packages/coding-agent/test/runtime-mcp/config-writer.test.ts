import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getMCPServer,
	readDisabledServers,
	setServerAutoload,
	setServerDisabled,
	upsertMCPServer,
} from "../../src/runtime-mcp/config-writer";
import type { MCPServerConfig } from "../../src/runtime-mcp/types";

let tmpDir: string;
let configPath: string;

const stdio = (command: string): MCPServerConfig => ({ command });

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-config-writer-"));
	configPath = path.join(tmpDir, "mcp.json");
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("upsertMCPServer", () => {
	test("adds a server that does not exist", async () => {
		const result = await upsertMCPServer(configPath, "alpha", stdio("alpha-bin"));
		expect(result).toEqual({ status: "added" });
		expect(await getMCPServer(configPath, "alpha")).toEqual(stdio("alpha-bin"));
	});

	test("skips an existing server without force and does not overwrite", async () => {
		await upsertMCPServer(configPath, "alpha", stdio("alpha-bin"));
		const result = await upsertMCPServer(configPath, "alpha", stdio("changed-bin"));
		expect(result).toEqual({ status: "skipped", reason: "exists" });
		// Original config is untouched.
		expect(await getMCPServer(configPath, "alpha")).toEqual(stdio("alpha-bin"));
	});

	test("updates an existing server with force", async () => {
		await upsertMCPServer(configPath, "alpha", stdio("alpha-bin"));
		const result = await upsertMCPServer(configPath, "alpha", stdio("changed-bin"), { force: true });
		expect(result).toEqual({ status: "updated" });
		expect(await getMCPServer(configPath, "alpha")).toEqual(stdio("changed-bin"));
	});

	test("throws on an invalid server name", async () => {
		await expect(upsertMCPServer(configPath, "has spaces", stdio("bin"))).rejects.toThrow();
		// Nothing was written.
		expect(await getMCPServer(configPath, "has spaces")).toBeUndefined();
	});

	test("throws on an invalid server config", async () => {
		// Missing `command`/`url` is not a valid MCP server config.
		await expect(upsertMCPServer(configPath, "alpha", {} as MCPServerConfig)).rejects.toThrow();
		expect(await getMCPServer(configPath, "alpha")).toBeUndefined();
	});

	test("preserves autoload:false when force-updating a server without the flag", async () => {
		await upsertMCPServer(configPath, "alpha", stdio("alpha-bin"));
		await setServerAutoload(configPath, "alpha", false);

		const result = await upsertMCPServer(configPath, "alpha", stdio("changed-bin"), { force: true });
		expect(result).toEqual({ status: "updated" });
		// upsert overwrites the whole server entry, so autoload resets to default (on).
		expect(await getMCPServer(configPath, "alpha")).toEqual(stdio("changed-bin"));
	});

	test("preserves disabledServers when force-updating a disabled server", async () => {
		await upsertMCPServer(configPath, "alpha", stdio("alpha-bin"));
		await setServerDisabled(configPath, "alpha", true);
		expect(await readDisabledServers(configPath)).toEqual(["alpha"]);

		const result = await upsertMCPServer(configPath, "alpha", stdio("changed-bin"), { force: true });
		expect(result).toEqual({ status: "updated" });
		// The server is updated but its disabled state is preserved.
		expect(await getMCPServer(configPath, "alpha")).toEqual(stdio("changed-bin"));
		expect(await readDisabledServers(configPath)).toEqual(["alpha"]);
	});
});

describe("setServerAutoload", () => {
	test("writes autoload:false and removes the key when re-enabled", async () => {
		await upsertMCPServer(configPath, "alpha", stdio("alpha-bin"));

		await setServerAutoload(configPath, "alpha", false);
		expect(await getMCPServer(configPath, "alpha")).toEqual({ command: "alpha-bin", autoload: false });

		// Autoload defaults to true, so enabling removes the redundant key entirely.
		await setServerAutoload(configPath, "alpha", true);
		expect(await getMCPServer(configPath, "alpha")).toEqual(stdio("alpha-bin"));
	});

	test("throws for an unknown server", async () => {
		await expect(setServerAutoload(configPath, "missing", false)).rejects.toThrow('Server "missing" not found');
	});

	test("preserves sibling fields and disabledServers", async () => {
		await upsertMCPServer(configPath, "alpha", { command: "alpha-bin", args: ["--x"], timeout: 5000 });
		await setServerDisabled(configPath, "alpha", true);

		await setServerAutoload(configPath, "alpha", false);

		expect(await getMCPServer(configPath, "alpha")).toEqual({
			command: "alpha-bin",
			args: ["--x"],
			timeout: 5000,
			autoload: false,
		});
		expect(await readDisabledServers(configPath)).toEqual(["alpha"]);
	});
});
