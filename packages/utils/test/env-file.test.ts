import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectEnvSnapshot } from "../src/env-file";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("projectEnvSnapshot quoted declarations", () => {
	test("compares a plain quoted literal and refuses a quoted escape", () => {
		const cwd = tempDir("gjc-env-quote-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'PLAIN="hello"\nESCAPED="a\\nb"\nBARE=/tmp/plain\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.values.PLAIN).toBe("hello");
		expect(snapshot.dynamic.has("PLAIN")).toBe(false);
		expect(snapshot.dynamic.has("ESCAPED")).toBe(true);
		expect(snapshot.dynamic.has("BARE")).toBe(false);
		expect(snapshot.values.BARE).toBe("/tmp/plain");
	});

	test("refuses a quote that continues onto the next physical line", () => {
		const cwd = tempDir("gjc-env-quote-ml-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.dynamic.has("GJC_CODING_AGENT_DIR")).toBe(true);
	});
});

const dirsSource = path.join(import.meta.dir, "../src/dirs.ts");

async function printedAgentDir(cwd: string, env: Record<string, string | undefined> = {}): Promise<string> {
	const script = path.join(cwd, "print-agent-dir.ts");
	await Bun.write(script, `import { getAgentDir } from ${JSON.stringify(dirsSource)};\nconsole.log(getAgentDir());\n`);
	const childEnv: Record<string, string | undefined> = { ...process.env, HOME: env.HOME, ...env };
	delete childEnv.GJC_CODING_AGENT_DIR;
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.GJC_CONFIG_DIR;
	delete childEnv.PI_CONFIG_DIR;
	if (env.GJC_CODING_AGENT_DIR !== undefined) childEnv.GJC_CODING_AGENT_DIR = env.GJC_CODING_AGENT_DIR;
	const proc = Bun.spawn([process.execPath, script], {
		cwd,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(stderr || stdout || `getAgentDir probe exited ${code}`);
	const printed = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (printed.length === 0) throw new Error(`getAgentDir probe printed nothing: ${stderr}`);
	return printed;
}

describe("getAgentDir quote provenance", () => {
	test("does not follow a double-quoted newline planted by the project .env", async () => {
		const cwd = tempDir("gjc-env-quote-nl-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-agent\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a planted value whose backslash is not an escape", async () => {
		const cwd = tempDir("gjc-env-quote-bs-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted\\agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted")).toBe(false);
	});

	test("does not follow a double-quoted agent dir split across physical lines", async () => {
		const cwd = tempDir("gjc-env-quote-ml-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-multiline")).toBe(false);
	});

	test("does not follow a legacy PI_CODING_AGENT_DIR quoted newline", async () => {
		const cwd = tempDir("gjc-env-quote-pi-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'PI_CODING_AGENT_DIR="/tmp/planted-pi\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-pi")).toBe(false);
	});

	test("does not follow a quoted CRLF that path.resolve would collapse", async () => {
		const cwd = tempDir("gjc-env-quote-crlf-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/segment\r\n/../planted-agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a backslash and physical CR planted inside double quotes", async () => {
		const cwd = tempDir("gjc-env-quote-cr-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-cr\\\r"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-cr")).toBe(false);
	});

	test("still honors an operator agent dir when the project has no .env", async () => {
		const cwd = tempDir("gjc-env-quote-op-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors a different unquoted operator agent dir", async () => {
		const cwd = tempDir("gjc-env-quote-op-unquoted-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), "GJC_CODING_AGENT_DIR=/tmp/planted-unquoted\n");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors an operator dir when a plain quote has a trailing comment", async () => {
		const cwd = tempDir("gjc-env-quote-op-comment-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/plain" # ordinary comment\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors an operator dir when an unquoted comment contains a quote", async () => {
		const cwd = tempDir("gjc-env-quote-op-unquoted-comment-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), "GJC_CODING_AGENT_DIR=/tmp/plain # operator's note\n");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors a different operator dir when the project quote is plain", async () => {
		const cwd = tempDir("gjc-env-quote-op-plain-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-plain"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});
});
