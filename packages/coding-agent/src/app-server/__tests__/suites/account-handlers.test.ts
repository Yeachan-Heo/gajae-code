import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { experimentalValidators } from "../../protocol-source/schema-validators.generated";
import { accountReadHandler } from "../../suites/account-handlers";

type HandlerResult = { ok: true; result: unknown } | { ok: false; errorKey: string };

const credentialEnvPattern = /(?:_API_KEY|_OAUTH_TOKEN|_ACCESS_TOKEN)$/;

function resultOf(value: HandlerResult): Record<string, unknown> {
	if (!value.ok) throw new Error(`account/read handler failed: ${value.errorKey}`);
	return value.result as Record<string, unknown>;
}

async function runIsolatedAccountProbe(agentDir: string): Promise<{ absent: HandlerResult; present: HandlerResult }> {
	const accountHandlersUrl = pathToFileURL(path.resolve(import.meta.dir, "../../suites/account-handlers.ts")).href;
	const authStorageUrl = pathToFileURL(path.resolve(import.meta.dir, "../../../session/auth-storage.ts")).href;
	const script = `
import { AuthStorage } from ${JSON.stringify(authStorageUrl)};
import { accountReadHandler } from ${JSON.stringify(accountHandlersUrl)};
const agentDir = process.env.GJC_AGENT_DIR;
if (!agentDir) throw new Error("GJC_AGENT_DIR missing");
const absent = await accountReadHandler({});
const authStorage = await AuthStorage.create(agentDir + "/auth.db");
await authStorage.set("openai", { type: "api_key", key: "fixture-api-key" });
authStorage.close();
const present = await accountReadHandler({ refreshToken: true });
console.log(JSON.stringify({ absent, present }));
`;
	const isolatedHome = mkdtempSync(path.join(tmpdir(), "gjc-account-home-"));
	try {
		const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<
			string,
			string
		>;
		env.HOME = isolatedHome;
		env.GJC_AGENT_DIR = agentDir;
		for (const name of Object.keys(env)) if (credentialEnvPattern.test(name)) delete env[name];
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: path.resolve(import.meta.dir, "../../../.."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const exitCode = await child.exited;
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout.trim()) as { absent: HandlerResult; present: HandlerResult };
	} finally {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
}

test("account/read: accepts an injected auth-state source for deterministic probes", async () => {
	const absent = resultOf(await accountReadHandler({}, { accountAuthState: () => false }));
	expect(absent).toEqual({ account: null, requiresOpenaiAuth: false });
	expect(experimentalValidators.clientRequestResults["account/read"]?.(absent)).toBe(true);

	const present = resultOf(await accountReadHandler({}, { accountAuthState: () => true }));
	expect(present).toEqual({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
	expect(experimentalValidators.clientRequestResults["account/read"]?.(present)).toBe(true);
});
test("account/read: returns truthful schema-valid API-key and absent responses", async () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "gjc-account-suite-"));
	try {
		const { absent, present } = await runIsolatedAccountProbe(agentDir);
		const absentResult = resultOf(absent);
		expect(absentResult).toEqual({ account: null, requiresOpenaiAuth: false });
		expect(experimentalValidators.clientRequestResults["account/read"]?.(absentResult)).toBe(true);

		const presentResult = resultOf(present);
		expect(presentResult).toEqual({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
		expect(experimentalValidators.clientRequestResults["account/read"]?.(presentResult)).toBe(true);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
