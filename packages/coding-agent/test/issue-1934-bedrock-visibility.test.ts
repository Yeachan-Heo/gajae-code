import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const fixture = path.resolve(import.meta.dir, "../../ai/test/fixtures/issue-1934-bedrock-auth-child.ts");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function runRegistry(
	scenario: "registry-static" | "registry-empty" | "registry-dotenv" | "registry-none",
): Promise<Record<string, unknown>> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue 1934 registry "));
	roots.push(root);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	await fs.mkdir(project, { recursive: true });
	if (scenario === "registry-dotenv") {
		await fs.writeFile(
			path.join(project, ".env"),
			"AWS_PROFILE=dotenv-profile\nAWS_SHARED_CREDENTIALS_FILE=dotenv-credentials\nAWS_CONFIG_FILE=dotenv-config\nAWS_ACCESS_KEY_ID=dotenv-key\nAWS_SECRET_ACCESS_KEY=dotenv-secret\nAWS_BEARER_TOKEN_BEDROCK=dotenv-token\nOPENAI_API_KEY=dotenv-openai\n",
		);
	}
	const launcher = path.join(project, "issue-1934-bedrock-visibility-launcher.ts");
	await fs.writeFile(launcher, `import ${JSON.stringify(pathToFileURL(fixture).href)};\n`);

	const proc = Bun.spawn({
		cmd: [process.execPath, launcher, scenario, root],
		cwd: project,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: Bun.env.PATH ?? "",
			HOME: home,
			USERPROFILE: home,
			TMPDIR: os.tmpdir(),
			XDG_CONFIG_HOME: path.join(root, "xdg-config"),
			XDG_DATA_HOME: path.join(root, "xdg-data"),
			XDG_STATE_HOME: path.join(root, "xdg-state"),
			XDG_CACHE_HOME: path.join(root, "xdg-cache"),
			GJC_CONFIG_DIR: path.join(root, "gjc-config"),
			GJC_CODING_AGENT_DIR: path.join(root, "agent"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			AWS_EC2_METADATA_DISABLED: "true",
			AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
			AWS_CONFIG_FILE: path.join(root, "config"),
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode).toBe(0);
	for (const secret of ["dotenv-key", "dotenv-secret", "dotenv-token", "dotenv-openai", "dummy"]) {
		expect(stdout).not.toContain(secret);
		expect(stderr).not.toContain(secret);
	}
	return JSON.parse(stdout) as Record<string, unknown>;
}

describe("issue #1934 Bedrock registry visibility", () => {
	test("lists bundled Bedrock models only for a credential-bearing shared profile", async () => {
		const result = await runRegistry("registry-static");
		expect(result.bedrock).toBe(true);
		expect(result.openai).toBe(false);
	});

	test("does not surface Bedrock or unrelated OpenAI models without credential sources", async () => {
		expect(await runRegistry("registry-empty")).toMatchObject({ bedrock: false, openai: false });
	});

	test("does not treat project dotenv AWS or OpenAI credentials as registry authentication", async () => {
		expect(await runRegistry("registry-dotenv")).toMatchObject({ bedrock: false, openai: false });
	});

	test("keeps explicit Bedrock auth none models available without AWS sources", async () => {
		const result = await runRegistry("registry-none");
		expect(result).toMatchObject({ bedrock: true, noAuth: true, key: result.noAuthSentinel });
	});
});
