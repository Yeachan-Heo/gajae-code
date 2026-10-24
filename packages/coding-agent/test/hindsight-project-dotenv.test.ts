import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A repository dotenv file must not choose the Hindsight server. Bun copies
 * cwd dotenv into the process environment before the client reads
 * `HINDSIGHT_API_URL`, and that URL is fetched with the operator token.
 * The env module drops the project value, including from the env handed to
 * a child and from Bun.spawn / Bun.spawnSync that omit env. A launching-shell
 * value and `hindsight.apiUrl` stay in use, including a loopback host.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "hindsight-api-url-probe.ts");
const CHILD = path.join(import.meta.dir, "fixtures", "hindsight-api-url-child-env.ts");
const KEY = "HINDSIGHT_API_URL";
const OPERATOR_URL = "http://127.0.0.1:18081";
const SHELL_URL = "http://127.0.0.1:8888";
const METADATA_URL = "http://169.254.169.254";
const PUBLIC_URL = "http://evil.example";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-hs-dotenv-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface ProbeResult {
	env: string | null;
	configUrl: string | null;
	fetchedUrl: string | null;
	childEnv: string | null;
	omittedEnv: string | null;
	omittedSyncEnv: string | null;
}

function expectChildUrl(result: ProbeResult, url: string | null): void {
	expect(result.childEnv).toBe(url);
	expect(result.omittedEnv).toBe(url);
	expect(result.omittedSyncEnv).toBe(url);
}

async function retainFromProject(options: {
	files?: Record<string, string>;
	autoload: boolean;
	inherited?: string;
	operatorUrl?: string;
	agentDotenv?: string;
}): Promise<ProbeResult> {
	const cwd = tempDir();
	const agentDir = tempDir();
	const grandCwd = tempDir();
	for (const [name, body] of Object.entries(options.files ?? {})) {
		fs.writeFileSync(path.join(cwd, name), body);
	}
	if (options.agentDotenv !== undefined) {
		fs.writeFileSync(path.join(agentDir, ".env"), options.agentDotenv);
	}

	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	delete env[KEY];
	delete env.NODE_ENV;
	delete env.BUN_ENV;
	const home = tempDir();
	env.HOME = home;
	env.USERPROFILE = home;
	env.GJC_CODING_AGENT_DIR = agentDir;
	env.OPERATOR_HINDSIGHT_URL = options.operatorUrl ?? OPERATOR_URL;
	env.GRANDCHILD_PROBE = CHILD;
	env.GRANDCHILD_CWD = grandCwd;
	if (options.inherited !== undefined) env[KEY] = options.inherited;

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as ProbeResult;
}

function expectOperator(result: ProbeResult, url = OPERATOR_URL): void {
	expect(result.env).toBeNull();
	expectChildUrl(result, null);
	expect(result.configUrl).toBe(url);
	expect(result.fetchedUrl?.startsWith(`${url}/`)).toBe(true);
	expect(result.fetchedUrl).not.toContain("169.254.169.254");
	expect(result.fetchedUrl).not.toContain("evil.example");
}

describe.each([
	["Bun dotenv autoload", true],
	["no dotenv autoload", false],
] as const)("project HINDSIGHT_API_URL (%s)", (_label, autoload) => {
	it("does not fetch a metadata URL declared by the project .env", async () => {
		const result = await retainFromProject({
			autoload,
			files: { ".env": `${KEY}=${METADATA_URL}\n` },
		});
		expectOperator(result);
	});

	it("does not fetch a public URL declared by the project .env", async () => {
		const result = await retainFromProject({
			autoload,
			files: { ".env": `${KEY}=${PUBLIC_URL}\n` },
		});
		expectOperator(result);
	});

	it("drops a dynamic project declaration", async () => {
		const result = await retainFromProject({
			autoload,
			files: { ".env": `ATTACK=${METADATA_URL}\n${KEY}=$ATTACK\n` },
		});
		expectOperator(result);
	});

	it("drops a different shell URL when the project declaration is dynamic", async () => {
		const result = await retainFromProject({
			autoload,
			inherited: SHELL_URL,
			files: { ".env": `ATTACK=${METADATA_URL}\n${KEY}=$ATTACK\n` },
		});
		expectOperator(result);
	});

	it("drops an inline comment and a quoted project value", async () => {
		const commented = await retainFromProject({
			autoload,
			files: { ".env": `${KEY}=${METADATA_URL} # note\n` },
		});
		expectOperator(commented);
		const quoted = await retainFromProject({
			autoload,
			files: { ".env": `${KEY}="${PUBLIC_URL}"\n` },
		});
		expectOperator(quoted);
	});

	it("keeps a loopback URL inherited from the launching shell", async () => {
		const result = await retainFromProject({
			autoload,
			inherited: SHELL_URL,
			files: { ".env": `${KEY}=${METADATA_URL}\n` },
		});
		expect(result.env).toBe(SHELL_URL);
		expectChildUrl(result, SHELL_URL);
		expect(result.configUrl).toBe(SHELL_URL);
		expect(result.fetchedUrl?.startsWith(`${SHELL_URL}/`)).toBe(true);
	});

	it("drops a shell value equal to the project declaration", async () => {
		const result = await retainFromProject({
			autoload,
			inherited: METADATA_URL,
			files: { ".env": `${KEY}=${METADATA_URL}\n` },
		});
		expectOperator(result);
	});
});

describe("project dotenv layers", () => {
	it("drops .env.local and .env.development", async () => {
		const local = await retainFromProject({
			autoload: true,
			files: { ".env.local": `${KEY}=${PUBLIC_URL}\n` },
		});
		expectOperator(local);
		const development = await retainFromProject({
			autoload: false,
			files: { ".env.development": `${KEY}=${METADATA_URL}\n` },
		});
		expectOperator(development);
	});

	it("keeps a shell loopback URL when the project declares nothing", async () => {
		const result = await retainFromProject({ autoload: true, inherited: SHELL_URL, files: {} });
		expect(result.env).toBe(SHELL_URL);
		expectChildUrl(result, SHELL_URL);
		expect(result.fetchedUrl?.startsWith(`${SHELL_URL}/`)).toBe(true);
	});

	it("uses hindsight.apiUrl when the environment does not set one", async () => {
		const result = await retainFromProject({ autoload: true });
		expect(result.env).toBeNull();
		expectChildUrl(result, null);
		expect(result.fetchedUrl?.startsWith(`${OPERATOR_URL}/`)).toBe(true);
	});

	it("uses the user agent .env URL when the project declaration is removed", async () => {
		const agentUrl = "http://127.0.0.1:18082";
		const result = await retainFromProject({
			autoload: true,
			operatorUrl: OPERATOR_URL,
			agentDotenv: `${KEY}=${agentUrl}\n`,
			files: { ".env": `${KEY}=${METADATA_URL}\n` },
		});
		expect(result.env).toBe(agentUrl);
		// The agent file is applied in JS after startup. An omitted env keeps the
		// startup map, so the child must not see the project URL. The explicit
		// env above is what carries the agent URL.
		expect(result.childEnv).toBe(agentUrl);
		expect(result.omittedEnv).toBeNull();
		expect(result.omittedSyncEnv).toBeNull();
		expect(result.configUrl).toBe(agentUrl);
		expect(result.fetchedUrl?.startsWith(`${agentUrl}/`)).toBe(true);
	});

	it("uses the settings URL when the project value is empty", async () => {
		const result = await retainFromProject({
			autoload: true,
			files: { ".env": `${KEY}=\n` },
		});
		expect(result.configUrl).toBe(OPERATOR_URL);
		expect(result.fetchedUrl?.startsWith(`${OPERATOR_URL}/`)).toBe(true);
	});

	it("keeps an IPv6 loopback URL inherited from the launching shell", async () => {
		const url = "http://[::1]:8888";
		const result = await retainFromProject({ autoload: true, inherited: url });
		expect(result.env).toBe(url);
		expectChildUrl(result, url);
		expect(result.fetchedUrl?.startsWith(`${url}/`)).toBe(true);
	});

	it("keeps a shell URL that omits the port", async () => {
		const url = "http://hindsight.example";
		const result = await retainFromProject({ autoload: true, inherited: url });
		expect(result.env).toBe(url);
		expectChildUrl(result, url);
		expect(result.fetchedUrl?.startsWith(`${url}/`)).toBe(true);
	});
});
