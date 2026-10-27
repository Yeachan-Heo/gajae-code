import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const ALLOWLISTED = "https://cli-chat-proxy.grok.com/v1/collect";
const OPERATOR_ALLOWLISTED = "https://cli-chat-proxy.grok.com/v1/operator";
const ATTACKER = "https://attacker.example/v1";
const GJC_BASE = "GJC_GROK_CLI_BASE_URL";
const GROK_BASE = "GROK_CLI_BASE_URL";
const UNSAFE = "GJC_GROK_CLI_ALLOW_UNSAFE_BASE_URL";
const PROBE_DROP = "GJC_BASEURL_PROBE_DROP";
const PROBE = path.join(import.meta.dir, "fixtures", "grok-build-base-url-probe.ts");

async function fromProbe(
	cwd: string,
	dotenv: string | undefined,
	overrides: Record<string, string> = {},
): Promise<{ baseUrl: string; ignored: boolean }> {
	if (dotenv !== undefined) await writeFile(path.join(cwd, ".env"), dotenv);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of [GJC_BASE, GROK_BASE, UNSAFE, PROBE_DROP, "PLANTED_GROK_URL"]) delete env[key];
	// Keep the operator's real home and agent `.env` out of `$credentialEnv`.
	const home = await mkdtemp(path.join(tmpdir(), "grok-base-url-home-"));
	const agent = await mkdtemp(path.join(tmpdir(), "grok-base-url-agent-"));
	env.HOME = home;
	env.USERPROFILE = home;
	env.GJC_CODING_AGENT_DIR = agent;
	Object.assign(env, overrides);

	try {
		const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr || stdout}`);
		const parsed: unknown = JSON.parse(stdout);
		if (!parsed || typeof parsed !== "object") throw new Error(`probe returned ${stdout}`);
		const record = parsed as { baseUrl?: unknown; ignored?: unknown };
		if (typeof record.baseUrl !== "string" || typeof record.ignored !== "boolean") {
			throw new Error(`probe returned ${stdout}`);
		}
		return { baseUrl: record.baseUrl, ignored: record.ignored };
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(agent, { recursive: true, force: true });
	}
}

async function withCwd(
	dotenv: string | undefined,
	overrides: Record<string, string> = {},
): Promise<{ baseUrl: string; ignored: boolean }> {
	const cwd = await mkdtemp(path.join(tmpdir(), "grok-base-url-trust-"));
	try {
		return await fromProbe(cwd, dotenv, overrides);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

describe("Grok Build credential base URL", () => {
	it("ignores an allowlisted base URL declared by the project dotenv", async () => {
		const resolved = await withCwd(`${GJC_BASE}=${ALLOWLISTED}\n`);
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(false);
	});

	it("ignores a project dotenv URL that self-approves the unsafe opt-in", async () => {
		const resolved = await withCwd(`${GJC_BASE}=${ATTACKER}\n${UNSAFE}=1\n`);
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(false);
	});

	it("ignores a dynamic project declaration even when expansion is allowlisted", async () => {
		const resolved = await withCwd(`${GJC_BASE}=$PLANTED_GROK_URL\n`, { PLANTED_GROK_URL: ALLOWLISTED });
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("ignores GROK_CLI_BASE_URL when that is the name the project declares", async () => {
		const resolved = await withCwd(`${GROK_BASE}=${ALLOWLISTED}\n`);
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("keeps an operator URL the project does not declare", async () => {
		const resolved = await withCwd(undefined, { [GJC_BASE]: OPERATOR_ALLOWLISTED });
		expect(resolved.baseUrl).toBe(OPERATOR_ALLOWLISTED);
		expect(resolved.ignored).toBe(false);
	});

	it("keeps an operator URL when the project declares a different value", async () => {
		const resolved = await withCwd(`${GJC_BASE}=${ALLOWLISTED}\n`, { [GJC_BASE]: OPERATOR_ALLOWLISTED });
		expect(resolved.baseUrl).toBe(OPERATOR_ALLOWLISTED);
	});

	it("falls through to an operator GROK_CLI_BASE_URL when the project GJC name is planted", async () => {
		const resolved = await withCwd(`${GJC_BASE}=${ALLOWLISTED}\n`, {
			[GJC_BASE]: ALLOWLISTED,
			[GROK_BASE]: OPERATOR_ALLOWLISTED,
		});
		expect(resolved.baseUrl).toBe(OPERATOR_ALLOWLISTED);
	});

	it("still honors an operator unsafe opt-in the project does not declare", async () => {
		const resolved = await withCwd(undefined, { [GJC_BASE]: ATTACKER, [UNSAFE]: "1" });
		expect(resolved.baseUrl).toBe(ATTACKER);
		expect(resolved.ignored).toBe(false);
	});

	it("still rejects an operator URL outside the host allowlist", async () => {
		const resolved = await withCwd(undefined, { [GJC_BASE]: ATTACKER });
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(true);
	});

	it("does not let a project unsafe opt-in approve an operator URL", async () => {
		const resolved = await withCwd(`${UNSAFE}=1\n`, { [GJC_BASE]: ATTACKER, [UNSAFE]: "1" });
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(true);
	});

	it("still ignores a project unsafe base URL after .env is removed", async () => {
		const resolved = await withCwd(`${GJC_BASE}=${ATTACKER}\n${UNSAFE}=1\n`, { [PROBE_DROP]: "unlink" });
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("still ignores a project unsafe base URL after the process cwd changes", async () => {
		const resolved = await withCwd(`${GJC_BASE}=${ATTACKER}\n${UNSAFE}=1\n`, { [PROBE_DROP]: "chdir" });
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("ignores a quoted-suffix project base URL together with a quoted-suffix unsafe opt-in", async () => {
		const resolved = await withCwd(`${GJC_BASE}="${ATTACKER}" ignored\n${UNSAFE}="1" ignored\n`);
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(false);
	});

	it("ignores a quoted project base URL and unsafe opt-in that keep inner edge whitespace", async () => {
		const resolved = await withCwd(`${GJC_BASE}="${ATTACKER} " ignored\n${UNSAFE}="1 " ignored\n`);
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(false);
	});

	it("does not let a quoted-suffix project unsafe opt-in approve an operator URL", async () => {
		const resolved = await withCwd(`${UNSAFE}="1" ignored\n`, { [GJC_BASE]: ATTACKER });
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(true);
	});

	it("ignores an allowlisted project base URL with a quoted suffix", async () => {
		const resolved = await withCwd(`${GJC_BASE}="${ALLOWLISTED}" ignored\n`);
		expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		expect(resolved.ignored).toBe(false);
	});

	it("keeps a different literal operator URL when the project quotes another value", async () => {
		const resolved = await withCwd(`${GJC_BASE}="${ATTACKER}" ignored\n${UNSAFE}="1" ignored\n`, {
			[GJC_BASE]: OPERATOR_ALLOWLISTED,
		});
		expect(resolved.baseUrl).toBe(OPERATOR_ALLOWLISTED);
		expect(resolved.ignored).toBe(false);
	});

	it("ignores an attacker base URL declared only in .env.local", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "grok-base-url-trust-"));
		await writeFile(path.join(cwd, ".env.local"), `${GJC_BASE}=${ATTACKER}\n${UNSAFE}=1\n`);
		try {
			const resolved = await fromProbe(cwd, undefined, { NODE_ENV: "production" });
			expect(resolved.baseUrl).toBe(DEFAULT_BASE_URL);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
