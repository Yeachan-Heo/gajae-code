import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GLM_ZCODE_OAUTH_AUTHORIZE_URL,
	GLM_ZCODE_OAUTH_BROKER_TOKEN_URL,
	GLM_ZCODE_OAUTH_CLIENT_ID,
	GLM_ZCODE_ZAI_LOGIN_URL,
} from "../src/utils/oauth/glm-zcode";

/**
 * Broker, authorize, and z/login receive the auth code or upstream token.
 * `projectEnv` is fixed at load from `process.cwd()`, so each case is a child.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "glm-zcode-oauth-env-probe.ts");
const KEYS = [
	"ZCODE_OAUTH_AUTHORIZE_URL",
	"ZCODE_OAUTH_CLIENT_ID",
	"ZCODE_OAUTH_REDIRECT_URI",
	"ZCODE_OAUTH_BROKER_TOKEN_URL",
	"ZCODE_OAUTH_ZAI_LOGIN_URL",
	"ZCODE_OAUTH_USERINFO_URL",
	"ZCODE_OAUTH_ZAI_API_BASE",
] as const;
const PLANTED = [
	"ZCODE_OAUTH_BROKER_TOKEN_URL=https://attacker.example/broker",
	"ZCODE_OAUTH_AUTHORIZE_URL=https://attacker.example/authorize",
	"ZCODE_OAUTH_ZAI_LOGIN_URL=https://attacker.example/login",
	"ZCODE_OAUTH_CLIENT_ID=attacker-client",
	"",
].join("\n");
const INHERITED = {
	ZCODE_OAUTH_BROKER_TOKEN_URL: "https://broker.internal.example/token",
	ZCODE_OAUTH_AUTHORIZE_URL: "https://authorize.internal.example/oauth",
	ZCODE_OAUTH_ZAI_LOGIN_URL: "https://login.internal.example/z",
	ZCODE_OAUTH_CLIENT_ID: "inherited-client",
};

interface Probe {
	authorize: string;
	clientId: string | null;
	broker: string | null;
	login: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-glm-zcode-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function endpoints(cwd: string, overrides: Record<string, string> = {}): Promise<Probe> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);
	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Probe;
}

function usesPlanted(probe: Probe): boolean {
	return [probe.authorize, probe.clientId, probe.broker, probe.login].some(
		value => value?.includes("attacker.example") || value?.includes("attacker-client"),
	);
}

describe("GLM ZCode OAuth endpoint trust", () => {
	it("still uses the built-in endpoints when nothing overrides them", async () => {
		const probe = await endpoints(projectDir());
		expect(probe.broker).toBe(GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
		expect(probe.login).toBe(GLM_ZCODE_ZAI_LOGIN_URL);
		const authorize = new URL(probe.authorize);
		expect(authorize.origin + authorize.pathname).toBe(GLM_ZCODE_OAUTH_AUTHORIZE_URL);
		expect(probe.clientId).toBe(GLM_ZCODE_OAUTH_CLIENT_ID);
	});

	it("ignores ZCode OAuth endpoints planted by the project .env", async () => {
		const probe = await endpoints(projectDir(PLANTED));
		expect(usesPlanted(probe)).toBe(false);
		expect(probe.broker).toBe(GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
	});

	it("still uses an inherited broker, authorize URL, login URL, and client id", async () => {
		const probe = await endpoints(projectDir(), INHERITED);
		expect(probe.broker).toBe(INHERITED.ZCODE_OAUTH_BROKER_TOKEN_URL);
		expect(probe.login).toBe(INHERITED.ZCODE_OAUTH_ZAI_LOGIN_URL);
		expect(probe.authorize.startsWith(INHERITED.ZCODE_OAUTH_AUTHORIZE_URL)).toBe(true);
		expect(probe.clientId).toBe(INHERITED.ZCODE_OAUTH_CLIENT_ID);
	});

	it("still uses an inherited broker when the project .env names a different one", async () => {
		const probe = await endpoints(projectDir(PLANTED), INHERITED);
		expect(probe.broker).toBe(INHERITED.ZCODE_OAUTH_BROKER_TOKEN_URL);
		expect(probe.clientId).toBe(INHERITED.ZCODE_OAUTH_CLIENT_ID);
		expect(usesPlanted(probe)).toBe(false);
	});

	it("ignores a distinct shell broker when the project declaration is dynamic", async () => {
		const probe = await endpoints(projectDir("ZCODE_OAUTH_BROKER_TOKEN_URL=$" + "{BROKER_HOST}\n"), {
			ZCODE_OAUTH_BROKER_TOKEN_URL: "https://operator.invalid/token",
		});
		expect(probe.broker).toBe(GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
	});

	it("ignores a broker URL whose shell value equals the project .env", async () => {
		const shared = "https://shared.example/token";
		const probe = await endpoints(projectDir(`ZCODE_OAUTH_BROKER_TOKEN_URL=${shared}\n`), {
			ZCODE_OAUTH_BROKER_TOKEN_URL: shared,
		});
		expect(probe.broker).toBe(GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
	});
});
