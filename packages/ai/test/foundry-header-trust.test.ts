import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `buildAnthropicClientOptions()` merges Foundry `ANTHROPIC_CUSTOM_HEADERS`
 * into the authenticated request. `$env` includes the caller's `cwd/.env`,
 * so a repository could previously attach its own headers while Foundry was
 * enabled by the operator.
 *
 * The project snapshot is read from `process.cwd()`, so these drive a child
 * process with a controlled directory.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "foundry-header-probe.ts");

interface ResolvedHeaders {
	error: string | null;
	userId: string | null;
	route: string | null;
	authorization: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-foundry-header-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<ResolvedHeaders> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of [
		"CLAUDE_CODE_USE_FOUNDRY",
		"FOUNDRY_BASE_URL",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_CUSTOM_HEADERS",
		"EVIL_USER",
		"GJC_FOUNDRY_HEADER_PROBE_DROP",
	]) {
		delete env[key];
	}
	env.CLAUDE_CODE_USE_FOUNDRY = "1";
	env.FOUNDRY_BASE_URL = "https://foundry.example.com";
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as ResolvedHeaders;
}

describe("Foundry custom header trust boundary", () => {
	it("ignores headers declared by the project .env", async () => {
		const dir = projectDir("ANTHROPIC_CUSTOM_HEADERS=user-id: repo-planted, x-route: repo-route\n");
		const resolved = await resolveIn(dir);
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBeNull();
		expect(resolved.route).toBeNull();
	});

	it("still ignores project headers after the dotenv file is removed", async () => {
		const dir = projectDir("ANTHROPIC_CUSTOM_HEADERS=user-id: repo-planted, x-route: repo-route\n");
		const resolved = await resolveIn(dir, { GJC_FOUNDRY_HEADER_PROBE_DROP: "unlink" });
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBeNull();
		expect(resolved.route).toBeNull();
	});

	it("still ignores project headers after the process cwd changes", async () => {
		const dir = projectDir("ANTHROPIC_CUSTOM_HEADERS=user-id: repo-planted, x-route: repo-route\n");
		const resolved = await resolveIn(dir, { GJC_FOUNDRY_HEADER_PROBE_DROP: "chdir" });
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBeNull();
		expect(resolved.route).toBeNull();
	});

	it("ignores headers produced from a $ or backtick declaration", async () => {
		const dir = projectDir("ANTHROPIC_CUSTOM_HEADERS=user-id: $EVIL_USER, x-route: `printf repo-route`\n");
		const resolved = await resolveIn(dir, { EVIL_USER: "mallory" });
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBeNull();
		expect(resolved.route).toBeNull();
	});

	it("ignores a quoted project header", async () => {
		const dir = projectDir('ANTHROPIC_CUSTOM_HEADERS="user-id: repo-quoted, x-route: repo-route"\n');
		const resolved = await resolveIn(dir);
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBeNull();
		expect(resolved.route).toBeNull();
	});

	it("keeps an operator newline header when the project single-quotes a backslash-n", async () => {
		const dir = projectDir("ANTHROPIC_CUSTOM_HEADERS='user-id: alice\\nx-route: engineering'\n");
		const resolved = await resolveIn(dir, {
			ANTHROPIC_CUSTOM_HEADERS: "user-id: alice\nx-route: engineering",
		});
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBe("alice");
		expect(resolved.route).toBe("engineering");
	});

	it("keeps operator headers the project does not declare", async () => {
		const dir = projectDir("UNRELATED=1\n");
		const resolved = await resolveIn(dir, {
			ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
		});
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBe("alice");
		expect(resolved.route).toBe("engineering");
	});

	it("keeps an operator value when the project declares a different static value", async () => {
		const dir = projectDir("ANTHROPIC_CUSTOM_HEADERS=user-id: repo-planted, x-route: repo-route\n");
		const resolved = await resolveIn(dir, {
			ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
		});
		expect(resolved.error).toBeNull();
		expect(resolved.authorization).toBe("Bearer foundry-token");
		expect(resolved.userId).toBe("alice");
		expect(resolved.route).toBe("engineering");
	});
});
