import { Settings } from "../../src/config/settings";
import { createHindsightClient } from "../../src/hindsight/client";
import { loadHindsightConfig } from "../../src/hindsight/config";

const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	fetched.push(url);
	return new Response("{}", { status: 200 });
}) as typeof fetch;

const operatorUrl = process.env.OPERATOR_HINDSIGHT_URL;
const settings = Settings.isolated(operatorUrl ? { "hindsight.apiUrl": operatorUrl } : {});
const config = loadHindsightConfig(settings);
let fetchedUrl: string | null = null;
if (config.hindsightApiUrl) {
	const client = createHindsightClient({ ...config, hindsightApiUrl: config.hindsightApiUrl });
	await client.retain("bank", "secret-memory");
	fetchedUrl = fetched[0] ?? null;
}

const grandProbe = process.env.GRANDCHILD_PROBE;
const grandCwd = process.env.GRANDCHILD_CWD;
if (!grandProbe || !grandCwd) throw new Error("missing grandchild spawn inputs");

async function readChild(proc: {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}): Promise<string | null> {
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`grandchild failed (${code}): ${err}`);
	const trimmed = out.trim();
	return trimmed === "" ? null : trimmed;
}

const explicit = Bun.spawn([process.execPath, "--no-env-file", grandProbe], {
	cwd: grandCwd,
	env: process.env,
	stdout: "pipe",
	stderr: "pipe",
});
const omitted = Bun.spawn([process.execPath, "--no-env-file", grandProbe], {
	cwd: grandCwd,
	stdout: "pipe",
	stderr: "pipe",
});
const omittedSync = Bun.spawnSync([process.execPath, "--no-env-file", grandProbe], {
	cwd: grandCwd,
	stdout: "pipe",
	stderr: "pipe",
});
if (omittedSync.exitCode !== 0) {
	throw new Error(`grandchild sync failed (${omittedSync.exitCode}): ${omittedSync.stderr.toString()}`);
}
const syncText = omittedSync.stdout.toString().trim();

console.log(
	JSON.stringify({
		env: process.env.HINDSIGHT_API_URL ?? null,
		configUrl: config.hindsightApiUrl,
		fetchedUrl,
		childEnv: await readChild(explicit),
		omittedEnv: await readChild(omitted),
		omittedSyncEnv: syncText === "" ? null : syncText,
	}),
);
