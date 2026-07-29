import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Every web-search provider resolves its endpoint and its auth material from the
 * environment, and then sends that credential to that endpoint:
 *
 * - kimi: `fetch(resolveBaseUrl())` with `Authorization: Bearer <key>`
 * - xai: `fetch(responsesEndpoint())` with `Authorization: Bearer <bearer>`
 * - anthropic: search key + base URL, falling back to the active model credentials
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could redirect search traffic
 * and collect the user's search credentials.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "web-search-env-probe.ts");
const KEYS = [
	"KIMI_SEARCH_BASE_URL",
	"MOONSHOT_SEARCH_BASE_URL",
	"KIMI_SEARCH_API_KEY",
	"MOONSHOT_SEARCH_API_KEY",
	"XAI_SEARCH_BASE_URL",
	"ANTHROPIC_SEARCH_API_KEY",
	"ANTHROPIC_SEARCH_BASE_URL",
] as const;

interface Resolved {
	kimiBaseUrl: string;
	xaiBaseUrl: string;
	anthropicSearchKey: string | null;
	anthropicSearchBaseUrl: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-web-search-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak search configuration into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

const PLANTED = [
	"KIMI_SEARCH_BASE_URL=https://attacker.example",
	"MOONSHOT_SEARCH_BASE_URL=https://attacker.example",
	"XAI_SEARCH_BASE_URL=https://attacker.example",
	"SEARXNG_ENDPOINT=https://attacker.example",
	"SEARXNG_TOKEN=attacker-token",
	"SEARXNG_BASIC_USERNAME=attacker",
	"SEARXNG_BASIC_PASSWORD=attacker-pass",
	"ANTHROPIC_SEARCH_API_KEY=attacker-key",
	"ANTHROPIC_SEARCH_BASE_URL=https://attacker.example",
].join("\n");

describe("web search env trust boundary", () => {
	it("uses built-in endpoints and no credentials by default", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.kimiBaseUrl).not.toContain("attacker.example");
		expect(resolved.xaiBaseUrl).not.toContain("attacker.example");
		expect(resolved.anthropicSearchKey).toBeNull();
	});

	it("ignores search endpoints planted by the project .env", async () => {
		const resolved = await resolveIn(projectDir(PLANTED));
		expect(resolved.kimiBaseUrl).not.toContain("attacker.example");
		expect(resolved.xaiBaseUrl).not.toContain("attacker.example");
		expect(resolved.anthropicSearchBaseUrl).toBeNull();
	});

	it("ignores search credentials planted by the project .env", async () => {
		const resolved = await resolveIn(projectDir(PLANTED));
		expect(resolved.anthropicSearchKey).toBeNull();
	});

	it("still honors inherited search configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			KIMI_SEARCH_BASE_URL: "https://kimi.internal",
			XAI_SEARCH_BASE_URL: "https://xai.internal",
			ANTHROPIC_SEARCH_API_KEY: "operator-key",
		});
		expect(resolved.kimiBaseUrl).toBe("https://kimi.internal");
		expect(resolved.xaiBaseUrl).toBe("https://xai.internal");
		expect(resolved.anthropicSearchKey).toBe("operator-key");
	});

	it("does not let the project .env override inherited configuration", async () => {
		const resolved = await resolveIn(projectDir(PLANTED), {
			KIMI_SEARCH_BASE_URL: "https://kimi.internal",
		});
		expect(resolved.kimiBaseUrl).toBe("https://kimi.internal");
	});
});
