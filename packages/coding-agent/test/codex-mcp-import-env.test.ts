/**
 * Codex MCP import must keep env-var indirections as names.
 * Resolving them would write the secret into project `.gjc/mcp.json`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyImport, buildImportPreview } from "@gajae-code/coding-agent/customization/import";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { expandEnvVarsDeep } from "../src/discovery/helpers";
import { normalizeCodexMcpToml } from "../src/discovery/mcp-compat";

const SECRET = "CANARY-CODEX-IMPORT-SECRET-9f3a";
const PASTED = "sk-PASTED-SECRET-CANARY-9f3a";
const TABLE_SECRET = "TABLE-SECRET-CANARY-9f3a";
const SET_NAMES = [
	"IMPORT_TOKEN",
	"IMPORT_OBJECT_TOKEN",
	"IMPORT_BEARER_TOKEN",
	"IMPORT_HEADER_TOKEN",
	"SHARED_TOKEN",
] as const;
const UNSET_NAMES = ["IMPORT_UNSET_TOKEN", "IMPORT_UNSET_HEADER_TOKEN"] as const;

function envRef(name: string): string {
	return `\${${name}}`;
}

const CODEX_TOML = `
[mcp_servers.stdioSrv]
command = "codex-bin"
env_vars = ["IMPORT_TOKEN", "IMPORT_UNSET_TOKEN", "SHARED_TOKEN", { name = "IMPORT_OBJECT_TOKEN" }]

[mcp_servers.stdioSrv.env]
LOG_LEVEL = "info"
SHARED_TOKEN = "operator-literal-value"

[mcp_servers.httpSrv]
url = "https://codex.example.test/mcp"
bearer_token_env_var = "IMPORT_BEARER_TOKEN"

[mcp_servers.httpSrv.http_headers]
X-Client = "codex-client"

[mcp_servers.httpSrv.env_http_headers]
X-Api-Key = "IMPORT_HEADER_TOKEN"
X-Unset = "IMPORT_UNSET_HEADER_TOKEN"

[mcp_servers.staticAuth]
url = "https://codex.example.test/static"
bearer_token_env_var = "IMPORT_BEARER_TOKEN"

[mcp_servers.staticAuth.http_headers]
Authorization = "operator-auth-literal"

[mcp_servers.bad]
command = "bin"

[mcp_servers.bad.env_vars]
SECRET = "${TABLE_SECRET}"

[mcp_servers.pasted]
url = "https://codex.example.test/pasted"
bearer_token_env_var = "${PASTED}"
`;

let tmpRoot: string;
let projectDir: string;
let homeDir: string;
let savedAgentDir: string;
let savedEnv: Map<string, string | undefined>;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-mcp-import-"));
	projectDir = path.join(tmpRoot, "project");
	homeDir = path.join(tmpRoot, "home");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	savedAgentDir = getAgentDir();
	setAgentDir(path.join(homeDir, ".gjc", "agent"));
	savedEnv = new Map();
	for (const name of [...SET_NAMES, ...UNSET_NAMES]) {
		savedEnv.set(name, process.env[name]);
		delete process.env[name];
	}
	for (const name of SET_NAMES) process.env[name] = SECRET;
});

afterEach(async () => {
	for (const [name, previous] of savedEnv) {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
	setAgentDir(savedAgentDir);
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("Codex MCP import env indirection", () => {
	test("project apply omits env references, writes no resolved secrets, and keeps operator values", async () => {
		for (const name of UNSET_NAMES) expect(Bun.env[name]).toBeUndefined();
		expect(Bun.env.IMPORT_TOKEN).toBe(SECRET);

		await fs.mkdir(path.join(projectDir, ".codex"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".codex", "config.toml"), CODEX_TOML, "utf-8");

		const plan = await buildImportPreview({
			product: "codex",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["mcps"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		const previewText = JSON.stringify(plan.preview);
		expect(previewText).not.toContain(SECRET);
		expect(previewText).not.toContain(PASTED);
		expect(previewText).not.toContain(TABLE_SECRET);
		expect(plan.preview.warnings.join("\n")).toContain("not a list of environment variable names");
		expect(plan.preview.warnings.join("\n")).toContain("not an environment variable name");
		expect(plan.preview.warnings.join("\n")).toContain("kept static env SHARED_TOKEN");
		expect(plan.preview.warnings.join("\n")).toContain("kept static Authorization");
		expect(plan.preview.warnings.join("\n")).toContain("skipped project-scope environment reference");

		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		expect(result.entries.every(entry => entry.outcome === "imported")).toBe(true);

		const mcpPath = path.join(projectDir, ".gjc", "mcp.json");
		const raw = await fs.readFile(mcpPath, "utf-8");
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain(PASTED);
		expect(raw).not.toContain(TABLE_SECRET);
		for (const name of [
			"IMPORT_TOKEN",
			"IMPORT_UNSET_TOKEN",
			"IMPORT_OBJECT_TOKEN",
			"IMPORT_BEARER_TOKEN",
			"IMPORT_HEADER_TOKEN",
			"IMPORT_UNSET_HEADER_TOKEN",
		]) {
			expect(raw).not.toContain(name);
		}

		const parsed = JSON.parse(raw) as {
			mcpServers: Record<
				string,
				{ env?: Record<string, string>; headers?: Record<string, string>; command?: string }
			>;
		};
		expect(parsed.mcpServers.stdioSrv?.env).toEqual({
			LOG_LEVEL: "info",
			SHARED_TOKEN: "operator-literal-value",
		});
		expect(parsed.mcpServers.httpSrv?.headers).toEqual({
			"X-Client": "codex-client",
		});
		expect(parsed.mcpServers.staticAuth?.headers).toEqual({ Authorization: "operator-auth-literal" });
		expect(parsed.mcpServers.bad?.env).toBeUndefined();
		expect(parsed.mcpServers.bad?.command).toBe("bin");
		expect(parsed.mcpServers.pasted?.headers).toBeUndefined();
	});

	test("keeps static env and a static header without reading the environment", async () => {
		const toml = `
[mcp_servers.plain]
command = "codex-bin"

[mcp_servers.plain.env]
LOG_LEVEL = "info"

[mcp_servers.web]
url = "https://codex.example.test/mcp"

[mcp_servers.web.http_headers]
X-Client = "codex-client"
`;
		await fs.mkdir(path.join(projectDir, ".codex"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".codex", "config.toml"), toml, "utf-8");
		const plan = await buildImportPreview({
			product: "codex",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["mcps"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		const result = await applyImport(plan, { cwd: projectDir });
		expect(result.ok).toBe(true);
		const raw = await fs.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf-8");
		expect(raw).not.toContain(SECRET);
		const parsed = JSON.parse(raw) as {
			mcpServers: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
		};
		expect(parsed.mcpServers.plain?.env).toEqual({ LOG_LEVEL: "info" });
		expect(parsed.mcpServers.web?.headers).toEqual({ "X-Client": "codex-client" });
	});

	test("project import leaves nothing for a later host expansion to fill", () => {
		const previous = process.env.CI_JOB_JWT_V2;
		delete process.env.CI_JOB_JWT_V2;
		try {
			const normalized = normalizeCodexMcpToml(
				`
[mcp_servers.httpSrv]
url = "https://codex.example.test/mcp"
bearer_token_env_var = "CI_JOB_JWT_V2"

[mcp_servers.stdioSrv]
command = "codex-bin"
env_vars = [{ name = "REMOTE_INDEX", source = "remote" }]
`,
				"project/.codex/config.toml",
				"project",
			);
			expect(normalized.warnings.join("\n")).toContain("skipped project-scope environment reference CI_JOB_JWT_V2");
			expect(normalized.warnings.join("\n")).toContain('source "remote" is not executed locally');
			const serialized = JSON.stringify(normalized.items);
			expect(serialized).not.toContain("CI_JOB_JWT_V2");
			expect(serialized).not.toContain("REMOTE_INDEX");
			process.env.CI_JOB_JWT_V2 = SECRET;
			const expanded = expandEnvVarsDeep(JSON.parse(serialized) as unknown, undefined, true);
			expect(JSON.stringify(expanded)).not.toContain(SECRET);
		} finally {
			if (previous === undefined) delete process.env.CI_JOB_JWT_V2;
			else process.env.CI_JOB_JWT_V2 = previous;
		}
	});

	test("user scope keeps a local reference and skips a remote source", () => {
		const normalized = normalizeCodexMcpToml(
			`
[mcp_servers.stdioSrv]
command = "codex-bin"
env_vars = ["IMPORT_TOKEN", { name = "REMOTE_INDEX", source = "remote" }, { name = "LOCAL_INDEX", source = "local" }]
`,
			"user/config.toml",
			"user",
		);
		expect(normalized.items[0]?.env).toEqual({
			IMPORT_TOKEN: envRef("IMPORT_TOKEN"),
			LOCAL_INDEX: envRef("LOCAL_INDEX"),
		});
		expect(normalized.warnings.join("\n")).toContain('source "remote" is not executed locally');
		expect(normalized.items[0]?.env?.REMOTE_INDEX).toBeUndefined();
	});

	test("a user source imported into the project does not leave a host reference", async () => {
		const previous = process.env.CI_JOB_JWT_V2;
		delete process.env.CI_JOB_JWT_V2;
		try {
			await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
			await fs.writeFile(
				path.join(homeDir, ".codex", "config.toml"),
				`
[mcp_servers.stdioSrv]
command = "codex-bin"
env_vars = ["IMPORT_TOKEN"]

[mcp_servers.stdioSrv.env]
LOG_LEVEL = "info"

[mcp_servers.httpSrv]
url = "https://codex.example.test/mcp"
bearer_token_env_var = "CI_JOB_JWT_V2"

[mcp_servers.httpSrv.http_headers]
X-Client = "codex-client"

[mcp_servers.httpSrv.env_http_headers]
X-Api-Key = "IMPORT_HEADER_TOKEN"
`,
				"utf-8",
			);
			const plan = await buildImportPreview({
				product: "codex",
				sourceScope: "user",
				destinationScope: "project",
				surfaces: ["mcps"],
				collisionPolicy: "skip",
				cwd: projectDir,
				homeDir,
			});
			const result = await applyImport(plan, { cwd: projectDir });
			expect(result.ok).toBe(true);
			const raw = await fs.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf-8");
			expect(raw).not.toContain("CI_JOB_JWT_V2");
			expect(raw).not.toContain("IMPORT_TOKEN");
			expect(raw).not.toContain("IMPORT_HEADER_TOKEN");
			expect(raw).not.toContain(SECRET);
			expect(raw).toContain("LOG_LEVEL");
			expect(raw).toContain("codex-client");
			process.env.CI_JOB_JWT_V2 = SECRET;
			const expanded = expandEnvVarsDeep(JSON.parse(raw) as unknown, undefined, true);
			expect(JSON.stringify(expanded)).not.toContain(SECRET);

			const globalPlan = await buildImportPreview({
				product: "codex",
				sourceScope: "user",
				destinationScope: "global",
				surfaces: ["mcps"],
				collisionPolicy: "skip",
				cwd: projectDir,
				homeDir,
			});
			const globalResult = await applyImport(globalPlan, { cwd: projectDir });
			expect(globalResult.ok).toBe(true);
			const globalRaw = await fs.readFile(path.join(homeDir, ".gjc", "agent", "mcp.json"), "utf-8");
			expect(globalRaw).toContain(envRef("IMPORT_TOKEN"));
			expect(globalRaw).toContain("LOG_LEVEL");
			expect(globalRaw).not.toContain(SECRET);
		} finally {
			if (previous === undefined) delete process.env.CI_JOB_JWT_V2;
			else process.env.CI_JOB_JWT_V2 = previous;
		}
	});

	test("a global import of local env names still yields the configured values", async () => {
		const previous = process.env.CI_JOB_JWT_V2;
		process.env.CI_JOB_JWT_V2 = SECRET;
		try {
			await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
			await fs.writeFile(
				path.join(homeDir, ".codex", "config.toml"),
				`
[mcp_servers.stdioSrv]
command = "codex-bin"
env_vars = ["IMPORT_TOKEN"]

[mcp_servers.stdioSrv.env]
LOG_LEVEL = "info"

[mcp_servers.httpSrv]
url = "https://codex.example.test/mcp"
bearer_token_env_var = "CI_JOB_JWT_V2"

[mcp_servers.httpSrv.http_headers]
X-Client = "codex-client"

[mcp_servers.httpSrv.env_http_headers]
X-Api-Key = "IMPORT_HEADER_TOKEN"
`,
				"utf-8",
			);
			const plan = await buildImportPreview({
				product: "codex",
				sourceScope: "user",
				destinationScope: "global",
				surfaces: ["mcps"],
				collisionPolicy: "skip",
				cwd: projectDir,
				homeDir,
			});
			const result = await applyImport(plan, { cwd: projectDir });
			expect(result.ok).toBe(true);
			const raw = await fs.readFile(path.join(homeDir, ".gjc", "agent", "mcp.json"), "utf-8");
			const expanded = expandEnvVarsDeep(JSON.parse(raw) as unknown, undefined, false);
			const text = JSON.stringify(expanded);
			expect(text).toContain(SECRET);
			expect(text).toContain("codex-bin");
			expect(text).toContain("LOG_LEVEL");
			expect(text).toContain("codex-client");
			expect(text).toContain("https://codex.example.test/mcp");
		} finally {
			if (previous === undefined) delete process.env.CI_JOB_JWT_V2;
			else process.env.CI_JOB_JWT_V2 = previous;
		}
	});
});
