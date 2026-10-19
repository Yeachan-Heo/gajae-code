import { afterEach, describe, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { safeRmSync } from "../../../scripts/safe-cleanup";

/**
 * Bun loads `.env.development` and `.env.development.local` when NODE_ENV is
 * unset. The project snapshot must see those declarations so the existing
 * project-dotenv denylist applies to them.
 */

const tempDirs: string[] = [];
const envSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
const envFileSourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/env-file.ts")).href;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) safeRmSync(dir, { force: true, recursive: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-env-development-layer-"));
	tempDirs.push(dir);
	return dir;
}

function writeProject(files: Record<string, string>): string {
	const dir = tempDir();
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
	return dir;
}

function runIsolated(cwd: string, script: string, env: Record<string, string> = {}, noEnvFile = false): void {
	const scriptPath = path.join(cwd, "env-development-layer-probe.ts");
	fs.writeFileSync(scriptPath, script);
	const tempHome = tempDir();
	const result = Bun.spawnSync({
		cmd: [process.execPath, ...(noEnvFile ? ["--no-env-file"] : []), scriptPath],
		cwd,
		env: {
			HOME: tempHome,
			USERPROFILE: tempHome, // Windows equivalent
			GJC_CODING_AGENT_DIR: tempDir(),
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
		throw new Error(output || `probe exited with ${result.exitCode}`);
	}
}

describe("development dotenv layer when NODE_ENV is unset", () => {
	it("drops a project TLS switch declared in .env.development when NODE_ENV is unset", () => {
		const cwd = writeProject({ ".env.development": "NODE_TLS_REJECT_UNAUTHORIZED=0\n" });
		runIsolated(
			cwd,
			`
import { $env } from ${JSON.stringify(envSourceUrl)};
if ($env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
	throw new Error("development TLS switch reached the live environment: " + $env.NODE_TLS_REJECT_UNAUTHORIZED);
}
`,
		);
	});

	it("classifies a development-layer worktree directory as project-controlled when NODE_ENV is unset", () => {
		const outside = tempDir();
		const cwd = writeProject({ ".env.development": `GJC_WORKTREE_DIR=${outside}\n` });
		runIsolated(
			cwd,
			`
import { projectEnvSnapshot } from ${JSON.stringify(envFileSourceUrl)};
const snapshot = projectEnvSnapshot(${JSON.stringify(cwd)});
if (snapshot.values.GJC_WORKTREE_DIR !== ${JSON.stringify(outside)}) {
	throw new Error("development worktree directory was not project-controlled: " + snapshot.values.GJC_WORKTREE_DIR);
}
if (snapshot.values.OTHER_OPERATOR !== undefined) {
	throw new Error("snapshot included an operator name the project did not declare");
}
`,
		);
	});

	it("drops a project TLS switch declared in .env.development when NODE_ENV is empty", () => {
		const cwd = writeProject({ ".env.development": "NODE_TLS_REJECT_UNAUTHORIZED=0\n" });
		runIsolated(
			cwd,
			`
import { $env } from ${JSON.stringify(envSourceUrl)};
if ($env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
	throw new Error("empty NODE_ENV still applied the development TLS switch");
}
`,
			{ NODE_ENV: "" },
		);
	});

	it("drops a provider credential declared in .env.development.local when NODE_ENV is unset", () => {
		const cwd = writeProject({
			".env.development": "ANTHROPIC_API_KEY=from-development\n",
			".env.development.local": "ANTHROPIC_API_KEY=from-development-local\n",
		});
		runIsolated(
			cwd,
			`
import { $credentialEnv, $env } from ${JSON.stringify(envSourceUrl)};
if ($env.ANTHROPIC_API_KEY !== "from-development-local") {
	throw new Error("development.local did not win the project layer: " + $env.ANTHROPIC_API_KEY);
}
if ($credentialEnv("ANTHROPIC_API_KEY") !== undefined) {
	throw new Error("development.local credential was treated as inherited");
}
`,
		);
	});

	it("keeps an inherited provider credential when NODE_ENV is unset", () => {
		const cwd = writeProject({ ".env.development": "UNRELATED_PROJECT_VALUE=1\n" });
		runIsolated(
			cwd,
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl)};
if ($credentialEnv("ANTHROPIC_API_KEY") !== "operator-key") {
	throw new Error("inherited credential was dropped: " + $credentialEnv("ANTHROPIC_API_KEY"));
}
`,
			{ ANTHROPIC_API_KEY: "operator-key" },
		);
	});

	it("keeps an inherited TLS value when NODE_ENV is unset", () => {
		const cwd = writeProject({ ".env.development.local": "UNRELATED_PROJECT_VALUE=1\n" });
		runIsolated(
			cwd,
			`
import { $env } from ${JSON.stringify(envSourceUrl)};
if ($env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") {
	throw new Error("inherited TLS value was not kept: " + $env.NODE_TLS_REJECT_UNAUTHORIZED);
}
`,
			{ NODE_TLS_REJECT_UNAUTHORIZED: "1" },
		);
	});

	it("expands development-layer references for unset and explicit development modes without Bun autoload", () => {
		const cwd = writeProject({
			".env.development": `PROJECT_ROOT=/repo\nEMPTY_ENV=\nVIRTUAL_ENV=$PROJECT_ROOT/.venv\nBRACED_ENV=\${PROJECT_ROOT}/bin\nESCAPED_ENV=\\$PROJECT_ROOT\nDEFAULT_ENV=\${PROJECT_MISSING:-fallback}\nEMPTY_DEFAULT=\${EMPTY_ENV:-fallback}\nDEFAULT_REFERENCE=\${PROJECT_MISSING:-$PROJECT_ROOT}\nNESTED_DEFAULT=\${PROJECT_MISSING:-\${PROJECT_ROOT}/fallback}\n`,
		});
		const script = `
import { $env } from ${JSON.stringify(envSourceUrl)};
if ($env.VIRTUAL_ENV !== "/repo/.venv") throw new Error("unbraced interpolation failed: " + $env.VIRTUAL_ENV);
if ($env.BRACED_ENV !== "/repo/bin") throw new Error("braced interpolation failed: " + $env.BRACED_ENV);
if ($env.ESCAPED_ENV !== "$PROJECT_ROOT") throw new Error("escaped interpolation failed: " + $env.ESCAPED_ENV);
if ($env.DEFAULT_ENV !== "fallback") throw new Error("unset default failed: " + $env.DEFAULT_ENV);
if ($env.EMPTY_DEFAULT !== "") throw new Error("empty existing value should not use the default: " + $env.EMPTY_DEFAULT);
if ($env.DEFAULT_REFERENCE !== "/repo") throw new Error("default reference failed: " + $env.DEFAULT_REFERENCE);
if ($env.NESTED_DEFAULT !== "/repo/fallback") throw new Error("nested default failed: " + $env.NESTED_DEFAULT);
		`;
		runIsolated(cwd, script, {}, true);
		runIsolated(cwd, script, { NODE_ENV: "development" }, true);
	});

	it("marks interpolated development-layer values as dynamic", () => {
		const cwd = writeProject({ ".env.development": `EXPANDED=$HOME/path\n` });
		runIsolated(
			cwd,
			`
import { projectEnvSnapshot } from ${JSON.stringify(envFileSourceUrl)};
const snapshot = projectEnvSnapshot(${JSON.stringify(cwd)});
if (!snapshot.dynamic.has("EXPANDED")) {
	throw new Error("interpolated development-layer value was not marked dynamic");
}
`,
		);
	});

	it("drops a TLS switch when .env.local and .env.development.local conflict", () => {
		const cwd = writeProject({
			".env.local": "NODE_TLS_REJECT_UNAUTHORIZED=0\n",
			".env.development.local": "NODE_TLS_REJECT_UNAUTHORIZED=1\n",
		});
		runIsolated(
			cwd,
			`
import { $env } from ${JSON.stringify(envSourceUrl)};
if ($env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
	throw new Error("conflicting TLS values did not drop the project value: " + $env.NODE_TLS_REJECT_UNAUTHORIZED);
}
`,
		);
	});

	it("keeps a production variable when a development file sets another value", () => {
		const cwd = writeProject({
			".env": "PROD_MARKER=from-dotenv\n",
			".env.development": "PROD_MARKER=from-dev\nDEV_ONLY_MARKER=from-dev\nNODE_TLS_REJECT_UNAUTHORIZED=0\n",
		});
		runIsolated(
			cwd,
			`
import { $credentialEnv, $env } from ${JSON.stringify(envSourceUrl)};
if ($env.PROD_MARKER !== "from-dotenv") throw new Error("production layer lost .env: " + $env.PROD_MARKER);
if ($env.DEV_ONLY_MARKER !== undefined) throw new Error("production loaded .env.development");
if ($env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) throw new Error("production loaded the development TLS switch");
if ($credentialEnv("ANTHROPIC_API_KEY") !== "operator-key") {
	throw new Error("production credential changed: " + $credentialEnv("ANTHROPIC_API_KEY"));
}
`,
			{ NODE_ENV: "production", ANTHROPIC_API_KEY: "operator-key" },
		);
	});
});
