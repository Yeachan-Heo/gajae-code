import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SdkClient } from "../packages/bridge-client/src/client";

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function run(command: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function requireSuccess(result: CliResult, label: string): string {
	if (result.exitCode !== 0) {
		throw new Error(`${label} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

async function waitForSession(binary: string, repo: string, agentDir: string, env: Record<string, string>): Promise<string> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const result = await run([binary, "daemon", "session", "list", "--agent-dir", agentDir], repo, env);
		if (result.exitCode === 0) {
			const frame = JSON.parse(result.stdout) as {
				result?: { sessions?: Array<{ sessionId?: string; live?: boolean }> };
			};
			const session = frame.result?.sessions?.find(candidate => candidate.live && candidate.sessionId);
			if (session?.sessionId) return session.sessionId;
		}
		await Bun.sleep(250);
	}
	throw new Error("Timed out waiting for the compiled GJC session SDK endpoint.");
}

async function queryAllModels(client: SdkClient): Promise<Array<{ provider?: string; id?: string }>> {
	const items: Array<{ provider?: string; id?: string }> = [];
	let cursor: string | undefined;
	do {
		const raw = await client.query("models.list/current", {}, cursor);
		const response = raw as {
			ok?: boolean;
			page?: {
				items?: Array<{ provider?: string; id?: string }>;
				complete?: boolean;
				continuationCursor?: string;
			};
		};
		if (!response.ok || !response.page) throw new Error(`Unexpected Q10 response: ${JSON.stringify(raw)}`);
		items.push(...(response.page.items ?? []));
		cursor = response.page.complete ? undefined : response.page.continuationCursor;
		if (!response.page.complete && !cursor) throw new Error("Incomplete Q10 page omitted its continuation cursor.");
	} while (cursor);
	return items;
}

const binary = path.resolve(process.argv[2] ?? "packages/coding-agent/dist/gjc");
const checkout = path.resolve(process.argv[3] ?? ".");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-active-provider-dogfood-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "agent");
const repo = path.join(root, "repo");
const tmuxSession = `gjc-active-provider-${process.pid}`;
const env = {
	HOME: home,
	GJC_CODING_AGENT_DIR: agentDir,
	DOGFOOD_PROVIDER_KEY: "dogfood-placeholder-not-a-real-secret",
};

try {
	await Promise.all([
		fs.mkdir(home, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(repo, { recursive: true }),
	]);
	requireSuccess(await run(["git", "init", "--quiet"], repo), "git init");
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:
  dogfood-local:
    baseUrl: http://127.0.0.1:9/v1
    auth: none
    api: openai-completions
    models:
      - id: local-model
        name: Dogfood Local Model
  dogfood-credential:
    baseUrl: http://127.0.0.1:9/v1
    apiKeyEnv: DOGFOOD_PROVIDER_KEY
    api: openai-completions
    models:
      - id: credential-model
        name: Dogfood Credential Model
`,
	);

	const launch = [
		"env",
		...Object.entries(env).map(([key, value]) => `${key}=${value}`),
		binary,
		"--model",
		"dogfood-local/local-model",
		"--no-tools",
		"--no-lsp",
		"--no-skills",
		"--no-rules",
		"--no-extensions",
	]
		.map(shellQuote)
		.join(" ");
	requireSuccess(await run(["tmux", "new-session", "-d", "-s", tmuxSession, "-c", repo, launch], checkout), "tmux launch");

	const sessionId = await waitForSession(binary, repo, agentDir, env);
	const activeRaw = requireSuccess(
		await run(
			[binary, "daemon", "session", "query", sessionId, "--query", "providers.list/active", "--json-input", "{}", "--agent-dir", agentDir],
			repo,
			env,
		),
		"providers.list/active",
	);
	const endpoint = (await Bun.file(path.join(repo, ".gjc", "state", "sdk", `${sessionId}.json`)).json()) as {
		url: string;
		token: string;
	};
	const client = await SdkClient.connect(endpoint.url, endpoint.token);
	const models = await queryAllModels(client);
	await client.close();
	const active = JSON.parse(activeRaw) as { ok?: boolean; page?: { items?: unknown[]; complete?: boolean } };
	const expected = [
		{ provider: "dogfood-credential", connectionKind: "credential" },
		{ provider: "dogfood-local", connectionKind: "credentialless" },
	];
	if (!active.ok || !active.page?.complete || JSON.stringify(active.page.items) !== JSON.stringify(expected)) {
		throw new Error(`Unexpected active-provider response: ${activeRaw}`);
	}
	if (!active.page.items?.every(item => Object.keys(item as object).sort().join(",") === "connectionKind,provider")) {
		throw new Error("Active-provider DTO exposed unexpected fields.");
	}
	const activeIds = new Set(expected.map(item => item.provider));
	const filteredModels = models.filter(model => model.provider && activeIds.has(model.provider));
	if (!activeIds.size || new Set(filteredModels.map(model => model.provider)).size !== activeIds.size) {
		throw new Error("Q10 model rows did not join exactly to every active provider.");
	}
	if (activeRaw.includes(env.DOGFOOD_PROVIDER_KEY)) throw new Error("Active-provider response leaked credential material.");

	const version = requireSuccess(await run([binary, "--version"], checkout), "compiled CLI version");
	const head = requireSuccess(await run(["git", "rev-parse", "HEAD"], checkout), "git rev-parse");
	const binarySha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex");
	process.stdout.write(
		`${JSON.stringify(
			{
				schemaVersion: 1,
				kind: "compiled-cli-sdk-dogfood",
				verdict: "passed",
				head,
				version,
				binarySha256,
				query: "providers.list/active",
				activeProviders: active.page.items,
				q10JoinedModels: filteredModels,
				invariants: [
					"compiled GJC binary hosted a live authenticated SDK session",
					"credential and credentialless providers were returned once in UTF-8 order",
					"DTOs contained only provider and connectionKind",
					"every active provider joined byte-for-byte to Q10 model rows",
					"credential material was absent from the response",
				],
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await run(["tmux", "kill-session", "-t", tmuxSession], checkout);
	await fs.rm(root, { recursive: true, force: true });
}
