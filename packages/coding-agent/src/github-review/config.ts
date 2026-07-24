/**
 * Configuration for the built-in GitHub code-review bot.
 *
 * One GitHub App webhook drives the whole pipeline: pull_request events start
 * reviews, issue_comment events carry `@<bot> <command>` commands and PR chat,
 * and pull_request_review_comment events are inline diff-thread replies.
 *
 * Config is a JSON file (default `~/.gjc/github-review.json`) with env
 * overrides so a launchd/systemd unit can tweak knobs without editing files.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GithubReviewConfig {
	/** GitHub App id (numeric string). */
	appId: string;
	/** Installation id of the App on the target org/user. */
	installationId: string;
	/** Path to the App's RS256 private key (.pem). */
	privateKeyPath: string;
	/** Webhook HMAC secret (X-Hub-Signature-256). */
	webhookSecret: string;
	/** Bot login WITHOUT the `[bot]` suffix (GraphQL identity), e.g. "gajae-code". */
	botLogin: string;
	/** Mention aliases that trigger the bot, e.g. ["gajae", "가재"]. */
	botAliases: string[];
	/** Display name used in bot prose, e.g. "가재". Defaults to botLogin. */
	botDisplayName: string;
	/** Marker/tmp-file prefix (`<!-- <prefix>-summary -->`). Defaults to botLogin. */
	markerPrefix: string;
	/** Check-run name shown on PRs. */
	checkName: string;
	/** HTTP listen host/port/path for the webhook endpoint. */
	host: string;
	port: number;
	webhookPath: string;
	/** Max reviews running at once; extra PRs queue in the state store. */
	maxInflight: number;
	/** Hard deadline for one review session, in minutes. */
	turnTimeoutMinutes: number;
	/** Optional model pattern for review sessions (default: configured default model). */
	modelPattern?: string;
	/** Working directory for review sessions (reviews are remote-read-only; any dir works). */
	cwd: string;
	/** State/cache/log root (state.json, events.jsonl, learnings/, app token cache). */
	dataDir: string;
	/** Repos (substring match, case-insensitive) the bot must never touch. */
	ignoreRepos: string[];
	/** Per-repo config filename fetched from the PR head, e.g. ".gajae.yaml". */
	repoConfigFile: string;
	/** In-flight reviews older than this are considered crashed (seconds). */
	inflightStaleSeconds: number;
	/** Background sweep interval (0 disables the in-process sweeper). */
	sweepIntervalSeconds: number;
	/** Check-runs stuck in_progress longer than this get force-closed (minutes). */
	sweepStaleMinutes: number;
	/** Command executed by the agent to post as the App, e.g. "gjc github-review gh". */
	postCommand: string;
	/** Command executed by the agent to finish a review, e.g. "gjc github-review complete". */
	completeCommand: string;
	/** Webhook URL used for self-requeue POSTs (drain path). */
	localWebhookUrl: string;
	/** GitHub API base (override for GHES/tests). */
	apiBase: string;
}

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".gjc", "github-review.json");

const DEFAULTS = {
	botAliases: [] as string[],
	checkName: "GJC Code Review",
	host: "127.0.0.1",
	port: 8644,
	webhookPath: "/webhooks/github-review",
	maxInflight: 4,
	turnTimeoutMinutes: 45,
	ignoreRepos: [] as string[],
	repoConfigFile: ".gjc-review.yml",
	inflightStaleSeconds: 20 * 60,
	sweepIntervalSeconds: 90,
	sweepStaleMinutes: 10,
	apiBase: "https://api.github.com",
};

function readJsonFile(filePath: string): Record<string, unknown> {
	const raw = fs.readFileSync(filePath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`github-review config must be a JSON object: ${filePath}`);
	}
	return parsed as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function strList(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	return v.filter((x): x is string => typeof x === "string");
}

/**
 * Load config from `filePath` (or DEFAULT_CONFIG_PATH), applying env overrides
 * (GJC_GHR_* namespace). Throws with a precise message when a required field
 * is missing — a review bot with a half-config must fail at startup, not at
 * the first webhook.
 */
export function loadGithubReviewConfig(filePath?: string, env: NodeJS.ProcessEnv = process.env): GithubReviewConfig {
	const configPath = filePath ?? env.GJC_GHR_CONFIG ?? DEFAULT_CONFIG_PATH;
	const file = fs.existsSync(configPath) ? readJsonFile(configPath) : {};

	const appId = env.GJC_GHR_APP_ID ?? str(file.appId);
	const installationId =
		env.GJC_GHR_INSTALLATION_ID ?? str(file.installationId) ?? num(file.installationId)?.toString();
	const privateKeyPath = env.GJC_GHR_PRIVATE_KEY ?? str(file.privateKeyPath);
	const webhookSecret = env.GJC_GHR_WEBHOOK_SECRET ?? str(file.webhookSecret);
	const botLogin = env.GJC_GHR_BOT_LOGIN ?? str(file.botLogin);
	const missing = Object.entries({ appId, installationId, privateKeyPath, webhookSecret, botLogin })
		.filter(([, v]) => !v)
		.map(([k]) => k);
	if (missing.length > 0) {
		throw new Error(`github-review config missing required field(s): ${missing.join(", ")} (config: ${configPath})`);
	}

	const port = num(env.GJC_GHR_PORT) ?? num(file.port) ?? DEFAULTS.port;
	const host = env.GJC_GHR_HOST ?? str(file.host) ?? DEFAULTS.host;
	const webhookPath = str(file.webhookPath) ?? DEFAULTS.webhookPath;
	const dataDir = env.GJC_GHR_DATA_DIR ?? str(file.dataDir) ?? path.join(os.homedir(), ".gjc", "github-review");
	const aliases = strList(file.botAliases) ?? DEFAULTS.botAliases;

	return {
		appId: appId as string,
		installationId: installationId as string,
		privateKeyPath: expandHome(privateKeyPath as string),
		webhookSecret: webhookSecret as string,
		botLogin: botLogin as string,
		botAliases: aliases.length > 0 ? aliases : [botLogin as string],
		botDisplayName: str(file.botDisplayName) ?? (botLogin as string),
		markerPrefix: str(file.markerPrefix) ?? (botLogin as string),
		checkName: str(file.checkName) ?? DEFAULTS.checkName,
		host,
		port,
		webhookPath,
		maxInflight: num(env.GJC_GHR_MAX_INFLIGHT) ?? num(file.maxInflight) ?? DEFAULTS.maxInflight,
		turnTimeoutMinutes:
			num(env.GJC_GHR_TURN_TIMEOUT_MIN) ?? num(file.turnTimeoutMinutes) ?? DEFAULTS.turnTimeoutMinutes,
		modelPattern: env.GJC_GHR_MODEL ?? str(file.modelPattern),
		cwd: expandHome(env.GJC_GHR_CWD ?? str(file.cwd) ?? os.homedir()),
		dataDir: expandHome(dataDir),
		ignoreRepos: strList(file.ignoreRepos) ?? DEFAULTS.ignoreRepos,
		repoConfigFile: str(file.repoConfigFile) ?? DEFAULTS.repoConfigFile,
		inflightStaleSeconds:
			num(env.GJC_GHR_INFLIGHT_STALE_SEC) ?? num(file.inflightStaleSeconds) ?? DEFAULTS.inflightStaleSeconds,
		sweepIntervalSeconds: num(file.sweepIntervalSeconds) ?? DEFAULTS.sweepIntervalSeconds,
		sweepStaleMinutes: num(env.GJC_GHR_SWEEP_MIN) ?? num(file.sweepStaleMinutes) ?? DEFAULTS.sweepStaleMinutes,
		postCommand: str(file.postCommand) ?? "gjc github-review gh",
		completeCommand: str(file.completeCommand) ?? "gjc github-review complete",
		localWebhookUrl: str(file.localWebhookUrl) ?? `http://127.0.0.1:${port}${webhookPath}`,
		apiBase: str(file.apiBase) ?? DEFAULTS.apiBase,
	};
}

function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
