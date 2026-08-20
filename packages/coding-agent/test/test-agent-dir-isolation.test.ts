/**
 * Test-process agent-directory isolation decision (scripts/test-agent-dir-isolation.ts).
 *
 * The preload that consumes this decision is what keeps `bun test` from writing
 * into the operator's live `~/.gjc/agent`. The decision is unit-tested here
 * because importing the preload would apply its environment mutations.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	decideAgentDirIsolation,
	defaultAgentDirFor,
	readProjectEnvFile,
	stripAmbientProviderEnvironment,
} from "../../../scripts/test-agent-dir-isolation";

const HOME = "/home/operator";
const DEFAULT_AGENT_DIR = path.join(HOME, ".gjc", "agent");
/** No path in these unit cases exists on disk, so realpath must not decide anything. */
const noRealpath = (target: string): string => {
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path: target });
};

describe("test agent-dir isolation decision", () => {
	test("isolates when no override is present", () => {
		expect(decideAgentDirIsolation({ home: HOME, env: {}, projectEnv: {}, realpath: noRealpath })).toEqual({
			action: "isolate",
			reason: "absent",
		});
	});

	test("isolates an ambient override that only restates the default agent dir", () => {
		// A gjc parent process exports this into every child it spawns, so
		// equality with the default carries no test intent.
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: DEFAULT_AGENT_DIR },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates a PI-only ambient override that restates the default", () => {
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { PI_CODING_AGENT_DIR: DEFAULT_AGENT_DIR },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates a default restated under a custom config dir name", () => {
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CONFIG_DIR: ".qa-gjc", GJC_CODING_AGENT_DIR: path.join(HOME, ".qa-gjc", "agent") },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates a symlinked spelling of the default agent dir", () => {
		const canonical = "/canonical/agent";
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: "/link/to/agent" },
				projectEnv: {},
				realpath: () => canonical,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates an override planted by the project .env even when non-default", () => {
		// Production `getAgentDir()` refuses a project-.env-sourced override, so
		// honoring it here would isolate nothing while production resolved the
		// live default directory.
		const planted = "/repo/shipped-agent-dir";
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: planted },
				projectEnv: { GJC_CODING_AGENT_DIR: planted },
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("honors an explicit trusted non-default pin", () => {
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: "/tmp/pinned-agent" },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "honor", agentDir: "/tmp/pinned-agent" });
	});

	test("a project-.env config dir name does not move the computed default", () => {
		// The name is distrusted, so the default stays under `.gjc` and an ambient
		// `.gjc/agent` override is still recognized as the default.
		expect(defaultAgentDirFor(HOME, { GJC_CONFIG_DIR: ".planted" }, { GJC_CONFIG_DIR: ".planted" })).toBe(
			DEFAULT_AGENT_DIR,
		);
	});

	test("an escaping config dir name falls back to the default name", () => {
		expect(defaultAgentDirFor(HOME, { GJC_CONFIG_DIR: "../escape" }, {})).toBe(DEFAULT_AGENT_DIR);
	});
});

describe("project .env reader", () => {
	test("parses assignments, strips quotes, and ignores comments", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-envread-"));
		try {
			await fs.promises.writeFile(
				path.join(dir, ".env"),
				[
					"# comment",
					'export GJC_CODING_AGENT_DIR="/quoted/dir" # inline comment',
					"PI_CONFIG_DIR = .plain#dotenv comment",
					"MALFORMED",
					"",
				].join("\n"),
			);
			expect(readProjectEnvFile(dir)).toEqual({
				GJC_CODING_AGENT_DIR: "/quoted/dir",
				PI_CONFIG_DIR: ".plain",
			});
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("a missing .env is an empty record, never a throw", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-envread-missing-"));
		try {
			expect(readProjectEnvFile(dir)).toEqual({});
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("provider environment isolation", () => {
	test("removes ambient provider credentials and endpoints without touching unrelated variables", () => {
		const env: Record<string, string | undefined> = {
			OPENAI_API_KEY: "ambient-key",
			OPENAI_BASE_URL: "https://provider.example.test/v1",
			ANTHROPIC_AUTH_TOKEN: "ambient-token",
			ANTHROPIC_SEARCH_MODEL: "ambient-search-model",
			AZURE_OPENAI_API_VERSION: "ambient-api-version",
			AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "ambient-deployments",
			AWS_PROFILE: "ambient-profile",
			AWS_REGION: "us-east-1",
			AWS_DEFAULT_REGION: "us-west-2",
			AWS_EC2_METADATA_DISABLED: "false",
			AWS_BEARER_TOKEN_BEDROCK: "ambient-bedrock-token",
			AWS_BEDROCK_SKIP_AUTH: "true",
			GOOGLE_APPLICATION_CREDENTIALS: "/ambient/credentials.json",
			HUGGINGFACE_HUB_TOKEN: "ambient-huggingface-token",
			GITHUB_TOKEN: "ambient-github-token",
			GITLAB_TOKEN: "ambient-gitlab-token",
			PERPLEXITY_COOKIES: "ambient-cookies",
			SEARXNG_ENDPOINT: "https://search.example.test",
			CLAUDE_CODE_CLIENT_KEY: "/ambient/client.key",
			NODE_EXTRA_CA_CERTS: "/ambient/ca.pem",
			KIRO_REGION: "ambient-region",
			OPENCODEX_HOME: "/ambient/opencodex",
			HTTPS_PROXY: "https://proxy.example.test",
			HTTP_PROXY: "http://proxy.example.test",
			ALL_PROXY: "socks5://proxy.example.test",
			https_proxy: "https://lower-proxy.example.test",
			http_proxy: "http://lower-proxy.example.test",
			all_proxy: "socks5://lower-proxy.example.test",
			ZCODE_APP_VERSION: "ambient-version",
			ZCODE_RELEASE_CHANNEL: "ambient-channel",
			PATH: "/usr/bin",
		};

		stripAmbientProviderEnvironment(env);

		expect(env).toEqual({ PATH: "/usr/bin" });
	});
});

describe("preload fail-closed behavior (real preload path)", () => {
	const preload = path.resolve(import.meta.dir, "../../../scripts/test-preload.ts");

	test("throws and never falls back to the live agent dir when the temp dir cannot be created", async () => {
		// Point the temp root at a path that cannot hold a new directory, so
		// mkdtempSync fails inside the real preload. Continuing would silently run
		// a suite against the operator's live ~/.gjc/agent.
		const blocker = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-failclosed-"));
		const notADir = path.join(blocker, "not-a-directory");
		await fs.promises.writeFile(notADir, "");
		try {
			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, "-e", "console.log(process.env.GJC_CODING_AGENT_DIR)"],
				env: {
					...process.env,
					TMPDIR: notADir,
					TMP: notADir,
					TEMP: notADir,
					GJC_CODING_AGENT_DIR: "",
					PI_CODING_AGENT_DIR: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(probe.exitCode).not.toBe(0);
			expect(probe.stderr.toString()).toContain("Test agent-directory isolation failed");
			// It must not have adopted (or printed) any agent dir at all.
			expect(probe.stdout.toString().trim()).toBe("");
		} finally {
			await fs.promises.rm(blocker, { recursive: true, force: true });
		}
	}, 30_000);

	test("an explicit trusted non-default pin survives the real preload", async () => {
		const pinned = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-preload-pinned-"));
		try {
			const probe = Bun.spawnSync({
				cmd: [process.execPath, "--preload", preload, "-e", "console.log(process.env.GJC_CODING_AGENT_DIR)"],
				env: { ...process.env, GJC_CODING_AGENT_DIR: pinned, PI_CODING_AGENT_DIR: "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(probe.exitCode).toBe(0);
			expect(probe.stdout.toString().trim()).toBe(pinned);
		} finally {
			await fs.promises.rm(pinned, { recursive: true, force: true });
		}
	}, 30_000);

	test("an ambient default agent dir is replaced by a fresh isolated dir in the real preload", async () => {
		const defaultAgentDir = path.join(os.homedir(), ".gjc", "agent");
		const probe = Bun.spawnSync({
			cmd: [process.execPath, "--preload", preload, "-e", "console.log(process.env.GJC_CODING_AGENT_DIR)"],
			env: { ...process.env, GJC_CODING_AGENT_DIR: defaultAgentDir, PI_CODING_AGENT_DIR: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const adopted = probe.stdout.toString().trim();
		expect(probe.exitCode).toBe(0);
		expect(adopted).not.toBe(defaultAgentDir);
		expect(path.basename(adopted).startsWith("gjc-test-agent-")).toBe(true);
		await fs.promises.rm(adopted, { recursive: true, force: true });
	}, 30_000);

	test("strips ambient provider environment in the real preload", async () => {
		const probe = Bun.spawnSync({
			cmd: [
				process.execPath,
				"--preload",
				preload,
				"-e",
				"console.log(JSON.stringify({ openaiKey: process.env.OPENAI_API_KEY, openaiBaseUrl: process.env.OPENAI_BASE_URL, path: process.env.PATH }))",
			],
			env: {
				...process.env,
				OPENAI_API_KEY: "ambient-key",
				OPENAI_BASE_URL: "https://provider.example.test/v1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(probe.exitCode).toBe(0);
		expect(JSON.parse(probe.stdout.toString())).toEqual({ path: process.env.PATH });
	}, 30_000);

	test("preserves explicit E2E provider credentials in the real preload", async () => {
		const probe = Bun.spawnSync({
			cmd: [
				process.execPath,
				"--preload",
				preload,
				"-e",
				"console.log(JSON.stringify({ e2e: process.env.E2E, openaiKey: process.env.OPENAI_API_KEY, openaiBaseUrl: process.env.OPENAI_BASE_URL }))",
			],
			env: {
				...process.env,
				E2E: "1",
				OPENAI_API_KEY: "e2e-key",
				OPENAI_BASE_URL: "https://e2e-provider.example.test/v1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(probe.exitCode).toBe(0);
		expect(JSON.parse(probe.stdout.toString())).toMatchObject({
			e2e: "1",
			openaiKey: "e2e-key",
			openaiBaseUrl: "https://e2e-provider.example.test/v1",
		});
	}, 30_000);
});
