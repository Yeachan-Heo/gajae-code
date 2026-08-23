import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { safeRmSync } from "../../../scripts/safe-cleanup";
import { $envpos, $flag, $pickenvpos, $pickflag, filterProcessEnv, parseEnvFile, parseShellEnvFile } from "../src/env";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		safeRmSync(dir, { force: true, recursive: true });
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
	it("accepts every assignment shape Bun's dotenv loader accepts", () => {
		const filePath = writeTempEnv(
			[
				"PLAIN=value",
				"export EXPORTED=exported-value",
				"export\tTABBED=tabbed-value",
				"SPACED_AROUND = spaced-value",
				"export SPACED_EXPORT = spaced-export-value",
				"INLINE_COMMENT=value # note",
				"INLINE_COMMENT_TIGHT=value#note",
				'QUOTED_HASH="value # kept"',
				"MULTI_WORD=a b",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			PLAIN: "value",
			EXPORTED: "exported-value",
			TABBED: "tabbed-value",
			SPACED_AROUND: "spaced-value",
			SPACED_EXPORT: "spaced-export-value",
			INLINE_COMMENT: "value",
			INLINE_COMMENT_TIGHT: "value",
			QUOTED_HASH: "value # kept",
			MULTI_WORD: "a b",
		});
	});

	it("loads Bun colon-form declarations in the project dotenv", () => {
		const filePath = writeTempEnv(
			[
				"AWS_ACCESS_KEY_ID: project-access",
				"GOOGLE_APPLICATION_CREDENTIALS: /tmp/project-adc.json",
				"DSN: postgres://project",
			].join("\n"),
		);
		expect(parseEnvFile(filePath)).toEqual({
			AWS_ACCESS_KEY_ID: "project-access",
			GOOGLE_APPLICATION_CREDENTIALS: "/tmp/project-adc.json",
			DSN: "postgres://project",
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
delete Bun.env.GJC_ENV_TEST_INHERITED_ONLY;
assertEqual($inheritedEnv("GJC_ENV_TEST_INHERITED_ONLY"), undefined, "deleted key is no longer inherited");
assertEqual($env.GJC_ENV_TEST_INHERITED_ONLY, undefined, "deleted key is gone from merged env");
`,
			{ GJC_ENV_TEST_INHERITED_ONLY: "shell-from-parent" },
			dir,
		);
	});
});

describe("$credentialEnv", () => {
	it("keeps colon-form project credentials out of the credential view", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-colon-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(
			path.join(dir, ".env"),
			[
				"DSN: postgres://project",
				"AWS_ACCESS_KEY_ID: project-access",
				"GOOGLE_APPLICATION_CREDENTIALS: /tmp/project-adc.json",
			].join("\n"),
		);
		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv, $env } from ${JSON.stringify(envSourceUrl)};
if ($env.DSN !== "postgres://project" || $env.AWS_ACCESS_KEY_ID !== "project-access" || $env.GOOGLE_APPLICATION_CREDENTIALS !== "/tmp/project-adc.json") throw new Error("colon dotenv values were not loaded");
for (const key of ["DSN", "AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS"]) if ($credentialEnv(key) !== undefined) throw new Error("project colon credential leaked");
`,
			{ HOME: home, GJC_CODING_AGENT_DIR: agentDir },
			dir,
		);
	});

	it("lets a static higher-precedence dotenv value clear dynamic provenance", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-dynamic-layer-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(dir, ".env"), "LAYERED_PROVIDER_KEY: $UNTRUSTED_DYNAMIC\n");
		fs.writeFileSync(path.join(dir, ".env.local"), "LAYERED_PROVIDER_KEY: static-project\n");
		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};
if ($credentialEnv("LAYERED_PROVIDER_KEY") !== "inherited-trusted") throw new Error("static winning dotenv layer was tainted by a lower dynamic declaration");
`,
			{ HOME: home, GJC_CODING_AGENT_DIR: agentDir, LAYERED_PROVIDER_KEY: "inherited-trusted" },
			dir,
		);
	});

	it("uses only the platform-effective HOME variable for trusted home files", () => {
		if (process.platform === "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-platform-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(home, ".env"), "HOME_TRUSTED_KEY: trusted-home\n");
		fs.writeFileSync(path.join(dir, ".env"), "USERPROFILE: $ATTACKER_HOME\n");
		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};
if ($credentialEnv("HOME_TRUSTED_KEY") !== "trusted-home") throw new Error("non-effective USERPROFILE changed trusted HOME selection");
`,
			{ HOME: home, GJC_CODING_AGENT_DIR: agentDir },
			dir,
		);
	});

	it("preserves inherited credentials when a hostile project HOME overlays the runtime HOME", () => {
		if (process.platform === "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-hostile-home-"));
		const hostileHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-hostile-home-root-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, hostileHome, agentDir);
		fs.writeFileSync(path.join(hostileHome, ".env"), "HOSTILE_HOME_CREDENTIAL=must-not-load\n");
		fs.writeFileSync(path.join(dir, ".env"), "HOME=$HOSTILE_HOME\n");
		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};
if ($credentialEnv("HOSTILE_HOME_CREDENTIAL") !== undefined) throw new Error("hostile HOME credential was loaded");
if ($credentialEnv("PRESERVED_OPERATOR_CREDENTIAL") !== "operator-value") throw new Error("inherited credential was dropped");
`,
			{ HOME: hostileHome, GJC_CODING_AGENT_DIR: agentDir, PRESERVED_OPERATOR_CREDENTIAL: "operator-value" },
			dir,
		);
	});
	it("keeps POSIX environment names case-sensitive when folding Windows declarations", () => {
		if (process.platform === "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-case-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-case-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(home, ".env"), "HOME_TRUSTED_KEY=trusted-home\n");
		// On POSIX `home` and `HOME` are distinct variables, so a lowercase
		// declaration must not make the authoritative home ambiguous. Folding it
		// would drop the trusted home's credentials on every POSIX host.
		fs.writeFileSync(path.join(dir, ".env"), "home=$ATTACKER_HOME\n");
		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};
if ($credentialEnv("HOME_TRUSTED_KEY") !== "trusted-home") throw new Error("lowercase home declaration folded into HOME on POSIX");
`,
			{ HOME: home, GJC_CODING_AGENT_DIR: agentDir },
			dir,
		);
	});
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

	it("reloads credentials whose inherited value came from the trusted agent env", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-rotating-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		const agentEnvPath = path.join(agentDir, ".env");
		fs.writeFileSync(agentEnvPath, "ROTATING_PROVIDER_KEY=old-token\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import * as fs from "node:fs";
import { $rotatingCredentialEnv } from ${JSON.stringify(envSourceUrl)};

if ($rotatingCredentialEnv("ROTATING_PROVIDER_KEY") !== "old-token") {
	throw new Error("initial agent credential was not resolved");
}
fs.writeFileSync(${JSON.stringify(path.join(agentDir, ".env.next"))}, "ROTATING_PROVIDER_KEY=new-token\\n");
fs.renameSync(${JSON.stringify(path.join(agentDir, ".env.next"))}, ${JSON.stringify(agentEnvPath)});
if ($rotatingCredentialEnv("ROTATING_PROVIDER_KEY") !== "new-token") {
	throw new Error("rotated agent credential was not reloaded");
}
const concurrentValues = await Promise.all(
	Array.from({ length: 32 }, () => Promise.resolve($rotatingCredentialEnv("ROTATING_PROVIDER_KEY"))),
);
if (concurrentValues.some(value => value !== "new-token")) {
	throw new Error("concurrent credential reads observed an inconsistent value");
}
fs.writeFileSync(${JSON.stringify(path.join(agentDir, ".env.next"))}, "");
fs.renameSync(${JSON.stringify(path.join(agentDir, ".env.next"))}, ${JSON.stringify(agentEnvPath)});
if ($rotatingCredentialEnv("ROTATING_PROVIDER_KEY") !== undefined) {
	throw new Error("removed agent credential must not fall back to its stale inherited value");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
				ROTATING_PROVIDER_KEY: "old-token",
			},
			dir,
		);
	});

	it("keeps shell precedence for names never owned by the agent env", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-shell-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		fs.writeFileSync(path.join(dir, ".env"), "PROJECT_ONLY_PROVIDER_KEY=project-token\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import { $rotatingCredentialEnv } from ${JSON.stringify(envSourceUrl)};

if ($rotatingCredentialEnv("SHELL_ONLY_PROVIDER_KEY") !== "shell-token") {
	throw new Error("a name never owned by the agent env lost shell precedence");
}
if ($rotatingCredentialEnv("PROJECT_ONLY_PROVIDER_KEY") !== undefined) {
	throw new Error("project dotenv must remain excluded from rotating credential resolution");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
				SHELL_ONLY_PROVIDER_KEY: "shell-token",
			},
			dir,
		);
	});

	it("lets the trusted agent env replace a stale inherited credential", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-pinned-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		const agentEnvPath = path.join(agentDir, ".env");
		fs.writeFileSync(agentEnvPath, "PINNED_PROVIDER_KEY=agent-token\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import * as fs from "node:fs";
import { $rotatingCredentialEnv } from ${JSON.stringify(envSourceUrl)};

fs.writeFileSync(${JSON.stringify(agentEnvPath)}, "PINNED_PROVIDER_KEY=rotated-agent-token\\n");
if ($rotatingCredentialEnv("PINNED_PROVIDER_KEY") !== "rotated-agent-token") {
	throw new Error("the trusted agent credential did not replace the stale inherited value");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
				PINNED_PROVIDER_KEY: "explicit-shell-token",
			},
			dir,
		);
	});

	it("fails closed for a symlinked or unreadable trusted agent env", () => {
		if (process.platform === "win32") return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-credential-link-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-home-"));
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-agent-"));
		tempDirs.push(dir, home, agentDir);
		const agentEnvPath = path.join(agentDir, ".env");
		const outsideEnvPath = path.join(dir, "outside.env");
		fs.writeFileSync(agentEnvPath, "UNSAFE_PROVIDER_KEY=old-token\n");
		fs.writeFileSync(outsideEnvPath, "UNSAFE_PROVIDER_KEY=outside-token\n");

		const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
		runEnvIsolationScript(
			`
import * as fs from "node:fs";
import { $rotatingCredentialEnv } from ${JSON.stringify(envSourceUrl)};

fs.rmSync(${JSON.stringify(agentEnvPath)});
fs.symlinkSync(${JSON.stringify(outsideEnvPath)}, ${JSON.stringify(agentEnvPath)});
if ($rotatingCredentialEnv("UNSAFE_PROVIDER_KEY") !== undefined) {
	throw new Error("a symlinked agent env must not provide credentials");
}
fs.rmSync(${JSON.stringify(agentEnvPath)});
fs.mkdirSync(${JSON.stringify(agentEnvPath)});
if ($rotatingCredentialEnv("UNSAFE_PROVIDER_KEY") !== undefined) {
	throw new Error("an unreadable agent env shape must fail closed");
}
`,
			{
				HOME: home,
				GJC_CODING_AGENT_DIR: agentDir,
				UNSAFE_PROVIDER_KEY: "old-token",
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

describe("$pickflag", () => {
	const GJC_NAME = "__GJC_UTILS_PICKFLAG_PROBE";
	const PI_NAME = "__PI_UTILS_PICKFLAG_PROBE";
	afterEach(() => {
		delete process.env[GJC_NAME];
		delete process.env[PI_NAME];
	});

	it("prefers the GJC-first key when both are set", () => {
		process.env[GJC_NAME] = "1";
		process.env[PI_NAME] = "0";
		expect($pickflag(GJC_NAME, PI_NAME)).toBe(true);
	});

	it("lets a falsy GJC value win over a truthy PI value (first set key decides)", () => {
		process.env[GJC_NAME] = "0";
		process.env[PI_NAME] = "1";
		expect($pickflag(GJC_NAME, PI_NAME)).toBe(false);
	});

	it("falls back to the PI key when the GJC key is unset", () => {
		process.env[PI_NAME] = "true";
		expect($pickflag(GJC_NAME, PI_NAME)).toBe(true);
	});

	it("returns false when neither key is set", () => {
		expect($pickflag(GJC_NAME, PI_NAME)).toBe(false);
	});

	it("applies TRUTHY case-insensitive matching per matched key", () => {
		process.env[GJC_NAME] = "YES";
		expect($pickflag(GJC_NAME, PI_NAME)).toBe(true);
		process.env[GJC_NAME] = "enabled";
		expect($pickflag(GJC_NAME, PI_NAME)).toBe(false);
	});
});

describe("$envpos", () => {
	const NAME = "__GJC_UTILS_ENVPOS_PROBE";

	afterEach(() => {
		delete process.env[NAME];
	});

	it.each([
		"12oops",
		"1.5",
		"1e3",
		"0",
		"-1",
		String(Number.MAX_SAFE_INTEGER + 1),
	])("returns the default for invalid complete-token value %j", value => {
		process.env[NAME] = value;
		expect($envpos(NAME, 100)).toBe(100);
	});

	it("accepts a whitespace-padded positive safe integer", () => {
		process.env[NAME] = " 42 ";
		expect($envpos(NAME, 100)).toBe(42);
	});

	it("accepts a zero-padded positive safe integer", () => {
		process.env[NAME] = "00042";
		expect($envpos(NAME, 100)).toBe(42);
	});
});

describe("$pickenvpos", () => {
	const GJC_NAME = "__GJC_UTILS_PICKENVPOS_PROBE";
	const PI_NAME = "__PI_UTILS_PICKENVPOS_PROBE";
	afterEach(() => {
		delete process.env[GJC_NAME];
		delete process.env[PI_NAME];
	});

	it("prefers a positive GJC-first value when both are set", () => {
		process.env[GJC_NAME] = "7";
		process.env[PI_NAME] = "9";
		expect($pickenvpos([GJC_NAME, PI_NAME], 100)).toBe(7);
	});

	it("falls back to the PI key when the GJC key is unset", () => {
		process.env[PI_NAME] = "42";
		expect($pickenvpos([GJC_NAME, PI_NAME], 100)).toBe(42);
	});

	it("returns the default when neither key is set", () => {
		expect($pickenvpos([GJC_NAME, PI_NAME], 100)).toBe(100);
	});

	it("returns the default when the only set value is invalid", () => {
		process.env[GJC_NAME] = "not-a-number";
		expect($pickenvpos([GJC_NAME, PI_NAME], 100)).toBe(100);
	});

	it("skips a set-but-invalid GJC key and falls through to a valid PI key", () => {
		process.env[GJC_NAME] = "-5";
		process.env[PI_NAME] = "3";
		expect($pickenvpos([GJC_NAME, PI_NAME], 100)).toBe(3);
	});

	it("skips a partially parsed GJC value and falls through to a valid PI key", () => {
		process.env[GJC_NAME] = "12oops";
		process.env[PI_NAME] = "3";
		expect($pickenvpos([GJC_NAME, PI_NAME], 100)).toBe(3);
	});
});
