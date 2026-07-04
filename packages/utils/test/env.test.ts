import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { $flag, filterProcessEnv, parseEnvFile, parseShellEnvFile } from "../src/env";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string, fileName = ".env"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, fileName);
	fs.writeFileSync(filePath, content);
	return filePath;
}

function runEnvIsolationScript(script: string, env: Record<string, string>, cwd: string): void {
	const scriptPath = path.join(cwd, "env-isolation.test.ts");
	fs.writeFileSync(scriptPath, script);

	const result = Bun.spawnSync({
		cmd: [process.execPath, scriptPath],
		cwd,
		env: {
			HOME: os.homedir(),
			PATH: Bun.env.PATH ?? "",
			...env,
		},
		stderr: "pipe",
		stdout: "pipe",
	});

	if (result.exitCode !== 0) {
		const output = [new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr)]
			.filter(Boolean)
			.join("\n");
		throw new Error(output || `env isolation script exited with ${result.exitCode}`);
	}
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("keeps legacy GJC_ variables from becoming PI_ defaults", () => {
		const filePath = writeTempEnv("GJC_FEATURE=enabled\nGJC_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			GJC_FEATURE: "enabled",
		});
	});
});

describe("parseShellEnvFile", () => {
	it("loads simple exported zshrc-style OpenAI env values without executing shell code", () => {
		const filePath = writeTempEnv(
			[
				"export OPENAI_BASE_URL=https://openai-proxy.example.com/v1",
				"OPENAI_API_KEY='shell-key' # local comment",
				"DYNAMIC_VALUE=$(secret-tool lookup service openai)",
				"BACKTICK_VALUE=`secret-tool lookup service openai`",
				"BAD_VALUE=before\0after",
			].join("\n"),
			".zshrc",
		);

		expect(parseShellEnvFile(filePath)).toEqual({
			OPENAI_BASE_URL: "https://openai-proxy.example.com/v1",
			OPENAI_API_KEY: "shell-key",
		});
	});
});

describe("$inheritedEnv", () => {
	it("keeps the inherited shell snapshot stable while $env reflects later fallback overlay mutation", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-inherited-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, ".env"), "GJC_ENV_TEST_UNUSED=unused\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $env, $inheritedEnv } from ${JSON.stringify(envSourceUrl)};

function assertEqual(actual: string | undefined, expected: string | undefined, label: string): void {
	if (actual !== expected) {
		throw new Error(\`\${label}: expected \${expected}, got \${actual}\`);
	}
}

assertEqual($inheritedEnv("GJC_ENV_TEST_INHERITED_ONLY"), "shell-from-parent", "inherited shell value");
assertEqual($env.GJC_ENV_TEST_INHERITED_ONLY, "shell-from-parent", "initial merged env value");
Bun.env.GJC_ENV_TEST_INHERITED_ONLY = "overlay-after-import";
assertEqual($inheritedEnv("GJC_ENV_TEST_INHERITED_ONLY"), "shell-from-parent", "stable inherited shell snapshot");
assertEqual($env.GJC_ENV_TEST_INHERITED_ONLY, "overlay-after-import", "live $env overlay value");
Bun.env.GJC_ENV_TEST_FALLBACK_ONLY = "fallback-after-import";
assertEqual($inheritedEnv("GJC_ENV_TEST_FALLBACK_ONLY"), undefined, "absent inherited value");
assertEqual($env.GJC_ENV_TEST_FALLBACK_ONLY, "fallback-after-import", "fallback remains available through $env");
`,
			{ GJC_ENV_TEST_INHERITED_ONLY: "shell-from-parent" },
			dir,
		);
	});
});

describe("$credentialEnv", () => {
	it("does not read provider credentials from the current project's .env overlay", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=project-key\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv, $env } from ${JSON.stringify(envSourceUrl)};

function assertEqual(actual: string | undefined, expected: string | undefined, label: string): void {
	if (actual !== expected) {
		throw new Error(\`\${label}: expected \${expected}, got \${actual}\`);
	}
}

assertEqual($env.ANTHROPIC_API_KEY, "project-key", "project dotenv remains available through $env");
assertEqual($credentialEnv("ANTHROPIC_API_KEY"), undefined, "provider credential excludes project dotenv");
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
			},
			dir,
		);
	});

	it("still resolves explicitly inherited provider credentials", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-inherited-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=project-key\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};

if ($credentialEnv("ANTHROPIC_API_KEY") !== "inherited-key") {
	throw new Error("inherited provider credential was not resolved");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
				ANTHROPIC_API_KEY: "inherited-key",
			},
			dir,
		);
	});

	it("uses the secure project-dotenv rule when inherited and project values are indistinguishable", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-ambiguous-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=same-key\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv, $env } from ${JSON.stringify(envSourceUrl)};

if ($env.ANTHROPIC_API_KEY !== "same-key") {
	throw new Error("project dotenv should remain available through $env");
}
if ($credentialEnv("ANTHROPIC_API_KEY") !== undefined) {
	throw new Error("ambiguous inherited/project dotenv match should not be used as provider credential");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
				ANTHROPIC_API_KEY: "same-key",
			},
			dir,
		);
	});

	it("resolves credential env values set after module import without trusting project dotenv", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-live-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(dir, ".env"), "LIVE_PROVIDER_KEY=project-live\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};

if ($credentialEnv("LIVE_PROVIDER_KEY") !== undefined) {
	throw new Error("project dotenv should not be used before live override");
}

Bun.env.LIVE_PROVIDER_KEY = "runtime-live";
if ($credentialEnv("LIVE_PROVIDER_KEY") !== "runtime-live") {
	throw new Error("runtime env override should be accepted as credential env");
}

Bun.env.LIVE_PROVIDER_KEY = "project-live";
if ($credentialEnv("LIVE_PROVIDER_KEY") !== undefined) {
	throw new Error("runtime value indistinguishable from project dotenv should remain excluded");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
			},
			dir,
		);
	});
});

describe("$pickCredentialEnv", () => {
	it("returns the first available credential key while excluding project dotenv", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-pick-credential-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(
			path.join(dir, ".env"),
			[
				"FIRST_PROVIDER_KEY=project-first",
				"SECOND_PROVIDER_KEY=project-second",
				"THIRD_PROVIDER_KEY=project-third",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(agentDir, ".env"),
			"SECOND_PROVIDER_KEY=agent-second\nTHIRD_PROVIDER_KEY=agent-third\n",
		);

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $env, $pickCredentialEnv } from ${JSON.stringify(envSourceUrl)};

if ($env.FIRST_PROVIDER_KEY !== "project-first") {
	throw new Error("project dotenv should remain available through $env");
}
const value = $pickCredentialEnv("FIRST_PROVIDER_KEY", "SECOND_PROVIDER_KEY", "THIRD_PROVIDER_KEY");
if (value !== "agent-second") {
	throw new Error(\`expected first non-project credential env value, got \${value}\`);
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
			},
			dir,
		);
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});

describe("$flag", () => {
	const NAME = "__PI_UTILS_FLAG_PROBE";
	afterEach(() => {
		delete process.env[NAME];
	});

	it("treats documented boolean-like values as truthy regardless of case", () => {
		for (const value of ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON", "y", "Y", " true "]) {
			process.env[NAME] = value;
			expect($flag(NAME)).toBe(true);
		}
	});

	it("treats non-boolean-like and falsy values as false", () => {
		for (const value of ["0", "false", "FALSE", "off", "no", "n", "2", "enabled", ""]) {
			process.env[NAME] = value;
			expect($flag(NAME)).toBe(false);
		}
	});

	it("returns the default when the variable is unset", () => {
		expect($flag(NAME)).toBe(false);
		expect($flag(NAME, true)).toBe(true);
	});
});
