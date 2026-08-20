/**
 * Decision logic for test-process agent-directory isolation.
 *
 * Kept separate from `scripts/test-preload.ts` so it is unit-testable: importing
 * the preload itself would apply its environment mutations as a side effect.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Environment inputs the decision reads. Injectable for tests. */
export interface AgentDirIsolationEnv {
	GJC_CODING_AGENT_DIR?: string | undefined;
	PI_CODING_AGENT_DIR?: string | undefined;
	GJC_CONFIG_DIR?: string | undefined;
	PI_CONFIG_DIR?: string | undefined;
}

export type AgentDirIsolationDecision =
	/** Replace the ambient value with a fresh isolated agent dir. */
	| { action: "isolate"; reason: "absent" | "default" | "untrusted" }
	/** An explicit, trusted, non-default pin: honor it. */
	| { action: "honor"; agentDir: string };

const AMBIENT_PROVIDER_ENV_PATTERN = /(?:_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_ACCESS_TOKEN|_BASE_URL)$/;
const AMBIENT_PROVIDER_ENV_EXACT = new Set([
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_SEARCH_MODEL",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_BEARER_TOKEN_KIRO",
	"AWS_CONFIG_FILE",
	"AWS_DEFAULT_REGION",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_SHARED_CREDENTIALS_FILE",
	"ALL_PROXY",
	"CLAUDE_CODE_CLIENT_CERT",
	"CLAUDE_CODE_CLIENT_KEY",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"COPILOT_GITHUB_TOKEN",
	"GCLOUD_PROJECT",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GITLAB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"HF_TOKEN",
	"HUGGINGFACE_HUB_TOKEN",
	"KIRO_REGION",
	"NODE_EXTRA_CA_CERTS",
	"OPENCODEX_HOME",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"PERPLEXITY_COOKIES",
	"QWEN_PORTAL_API_KEY",
	"SEARXNG_BASIC_PASSWORD",
	"SEARXNG_BASIC_USERNAME",
	"SEARXNG_ENDPOINT",
	"SEARXNG_TOKEN",
	"ZCODE_APP_VERSION",
	"ZCODE_RELEASE_CHANNEL",
]);

/** Remove provider credentials and endpoints inherited from the operator shell. */
export function stripAmbientProviderEnvironment(env: Record<string, string | undefined>): void {
	for (const key of Object.keys(env)) {
		if (AMBIENT_PROVIDER_ENV_PATTERN.test(key) || AMBIENT_PROVIDER_ENV_EXACT.has(key)) delete env[key];
	}
}

/**
 * Minimal `KEY=value` reader for the caller's project `.env`.
 *
 * `getAgentDir()` refuses an agent-dir override whose value matches what the
 * project `.env` sets, because Bun loads `cwd/.env` into `process.env` before
 * any module runs and a repository could otherwise redirect the trusted config
 * root it ships. The preload must apply the same rule or a repo-planted pin
 * would be honored here and rejected in production — isolation would silently
 * not happen while production resolved the live default directory.
 */
export function readProjectEnvFile(cwd: string): Record<string, string> {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(cwd, ".env"), "utf8");
	} catch {
		return {};
	}
	const values: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		const key = match[1]!;
		let value = match[2]!.trim();
		let quote: '"' | "'" | undefined;
		for (let index = 0; index < value.length; index++) {
			const char = value[index];
			if (char === "\\") {
				index++;
				continue;
			}
			if ((char === '"' || char === "'") && (!quote || quote === char)) {
				quote = quote ? undefined : char;
				continue;
			}
			if (char === "#" && !quote) {
				value = value.slice(0, index).trimEnd();
				break;
			}
		}
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		)
			value = value.slice(1, -1);
		values[key] = value;
	}
	return values;
}

/**
 * A configured directory name must stay a single home-relative name; `..`
 * segments escape the config root, and production falls back to the default
 * name for such a value. Mirroring that here keeps the computed default agent
 * dir identical to the one production will resolve.
 */
function sanitizeConfigDirName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (path.normalize(trimmed).split(/[\\/]/).includes("..")) return undefined;
	return trimmed;
}

/** The agent directory production would resolve with no trusted override. */
export function defaultAgentDirFor(home: string, env: AgentDirIsolationEnv, projectEnv: Record<string, string>): string {
	const trusted = (name: "GJC_CONFIG_DIR" | "PI_CONFIG_DIR"): string | undefined => {
		const value = env[name];
		if (!value) return undefined;
		// Same distrust rule as production: a value planted by the project `.env`
		// is not honored.
		if (projectEnv[name] === value) return undefined;
		return value;
	};
	const configDirName =
		sanitizeConfigDirName(trusted("GJC_CONFIG_DIR")) ?? sanitizeConfigDirName(trusted("PI_CONFIG_DIR")) ?? ".gjc";
	return path.join(home, configDirName, "agent");
}

/**
 * Decide whether this test process must be isolated into a fresh agent dir.
 *
 * Isolation is the default. An ambient override is deferred to ONLY when it is
 * trusted (not planted by the project `.env`) and points somewhere other than
 * the default agent dir: a `gjc` parent process exports
 * `GJC_CODING_AGENT_DIR=<home>/<config>/agent` into every child it spawns, so
 * equality with the default carries no test intent.
 */
export function decideAgentDirIsolation(input: {
	home: string;
	env: AgentDirIsolationEnv;
	projectEnv: Record<string, string>;
	realpath?: (target: string) => string;
}): AgentDirIsolationDecision {
	const { env, projectEnv } = input;
	const realpath = input.realpath ?? ((target: string) => fs.realpathSync(target));
	const configured = env.GJC_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR;
	if (!configured) return { action: "isolate", reason: "absent" };
	if (projectEnv.GJC_CODING_AGENT_DIR === configured || projectEnv.PI_CODING_AGENT_DIR === configured)
		return { action: "isolate", reason: "untrusted" };
	const defaultAgentDir = defaultAgentDirFor(input.home, env, projectEnv);
	const resolved = path.resolve(configured);
	if (resolved === defaultAgentDir) return { action: "isolate", reason: "default" };
	try {
		if (realpath(resolved) === realpath(defaultAgentDir)) return { action: "isolate", reason: "default" };
	} catch {
		// An unresolvable path cannot be the existing default directory.
	}
	return { action: "honor", agentDir: configured };
}
