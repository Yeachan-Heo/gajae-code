import type { CredentialHealthResult, Provider, UsageLimit, UsageStatus, UsageUnit } from "@gajae-code/ai";
import { discoverAuthStorage } from "../sdk";

export const USAGE_PROVIDER = "openai-codex" satisfies Provider;
export const DEFAULT_USAGE_TIMEOUT_MS = 10_000;
export const MIN_USAGE_TIMEOUT_MS = 1_000;
export const MAX_USAGE_TIMEOUT_MS = 30_000;

export interface UsageCommandArgs {
	json: boolean;
	live: true;
	timeoutMs: number;
}

export type UsageParseResult =
	| { kind: "args"; args: UsageCommandArgs }
	| { kind: "help" }
	| { kind: "error"; message: string };

interface UsageAuthStorage {
	checkCredentials(options: { timeoutMs: number; providers: readonly Provider[] }): Promise<CredentialHealthResult[]>;
	close(): void;
}

interface UsageCommandDeps {
	discoverAuthStorage: () => Promise<UsageAuthStorage>;
	now: () => number;
	write: (value: string) => void;
}

export interface UsageJsonV1 {
	schemaVersion: 1;
	fetchedAt: number;
	provider: typeof USAGE_PROVIDER;
	live: true;
	accounts: UsageAccountV1[];
}

export interface UsageAccountV1 {
	identity: { email: string | null; accountId: string | null };
	status: "ok" | "error" | "unavailable";
	error: null | "probe_failed" | "probe_unavailable";
	limits: UsageLimitV1[];
}

export interface UsageLimitV1 {
	id: string;
	label: string;
	status: UsageStatus | null;
	window: { id: string; label: string; durationMs: number | null; resetsAt: number | null } | null;
	amount: {
		unit: UsageUnit;
		used: number | null;
		limit: number | null;
		remaining: number | null;
		usedFraction: number | null;
		remainingFraction: number | null;
	};
}

const defaultDeps: UsageCommandDeps = {
	discoverAuthStorage,
	now: Date.now,
	write: value => process.stdout.write(value),
};

function isHelpArg(arg: string): boolean {
	return arg === "--help" || arg === "-h";
}

function isDecimalInteger(value: string): boolean {
	return /^[0-9]+$/.test(value);
}

function validateTimeout(value: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
	if (value === undefined) return { ok: false, message: "--timeout requires a value" };
	if (!isDecimalInteger(value)) return { ok: false, message: "--timeout must be an integer number of milliseconds" };
	const timeoutMs = Number.parseInt(value, 10);
	if (timeoutMs < MIN_USAGE_TIMEOUT_MS || timeoutMs > MAX_USAGE_TIMEOUT_MS) {
		return {
			ok: false,
			message: `--timeout must be between ${MIN_USAGE_TIMEOUT_MS} and ${MAX_USAGE_TIMEOUT_MS} milliseconds`,
		};
	}
	return { ok: true, value: timeoutMs };
}

export function parseUsageRawArgv(argv: readonly string[]): UsageParseResult {
	if (argv.length === 1 && isHelpArg(argv[0])) return { kind: "help" };
	if (argv.some(isHelpArg)) return { kind: "error", message: "usage help cannot be combined with other arguments" };

	let live = false;
	let json = false;
	let timeoutMs = DEFAULT_USAGE_TIMEOUT_MS;
	let timeoutSeen = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") return { kind: "error", message: "usage does not accept positional arguments" };
		if (arg === "--live") {
			if (live) return { kind: "error", message: "duplicate --live flag" };
			live = true;
			continue;
		}
		if (arg === "--json" || arg === "-j") {
			if (json) return { kind: "error", message: "duplicate --json flag" };
			json = true;
			continue;
		}
		if (arg === "--timeout") {
			if (timeoutSeen) return { kind: "error", message: "duplicate --timeout flag" };
			timeoutSeen = true;
			const parsed = validateTimeout(argv[i + 1]);
			if (!parsed.ok) return { kind: "error", message: parsed.message };
			timeoutMs = parsed.value;
			i++;
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			return { kind: "error", message: "use --timeout <milliseconds>" };
		}
		if (arg === "--provider" || arg.startsWith("--provider=")) {
			return { kind: "error", message: "usage is fixed to openai-codex and does not accept --provider" };
		}
		if (arg.startsWith("-")) return { kind: "error", message: `unknown usage flag: ${arg}` };
		return { kind: "error", message: "usage does not accept positional arguments" };
	}

	if (!live) return { kind: "error", message: "usage requires --live" };
	return { kind: "args", args: { json, live: true, timeoutMs } };
}

function nullableNumber(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toUsageLimit(limit: UsageLimit): UsageLimitV1 {
	return {
		id: limit.id,
		label: limit.label,
		status: limit.status ?? null,
		window: limit.window
			? {
					id: limit.window.id,
					label: limit.window.label,
					durationMs: nullableNumber(limit.window.durationMs),
					resetsAt: nullableNumber(limit.window.resetsAt),
				}
			: null,
		amount: {
			unit: limit.amount.unit,
			used: nullableNumber(limit.amount.used),
			limit: nullableNumber(limit.amount.limit),
			remaining: nullableNumber(limit.amount.remaining),
			usedFraction: nullableNumber(limit.amount.usedFraction),
			remainingFraction: nullableNumber(limit.amount.remainingFraction),
		},
	};
}

export function toUsageAccount(result: CredentialHealthResult): UsageAccountV1 {
	if (result.ok === true) {
		return {
			identity: { email: result.email ?? null, accountId: result.accountId ?? null },
			status: "ok",
			error: null,
			limits: (result.report?.limits ?? []).map(toUsageLimit),
		};
	}
	return {
		identity: { email: result.email ?? null, accountId: result.accountId ?? null },
		status: result.ok === false ? "error" : "unavailable",
		error: result.ok === false ? "probe_failed" : "probe_unavailable",
		limits: [],
	};
}

export function formatUsageText(result: UsageJsonV1): string {
	if (result.accounts.length === 0) return `No stored ${USAGE_PROVIDER} credentials found.\n`;
	const lines = result.accounts.map((account, index) => {
		const identity = account.identity.email ?? account.identity.accountId ?? `account ${index + 1}`;
		if (account.status !== "ok") return `${identity}: ${account.status} (${account.error})`;
		const limits = account.limits
			.map(limit => {
				const remaining = limit.amount.remaining;
				return `${limit.label}: ${remaining === null ? "unknown" : `${remaining}%`} remaining`;
			})
			.join(", ");
		return `${identity}: ${limits || "usage available"}`;
	});
	return `${lines.join("\n")}\n`;
}

export function renderUsageHelp(bin: string): string {
	return `View live OpenAI Codex usage for stored GJC credentials\n\nUSAGE\n  $ ${bin} usage --live [FLAGS]\n\nFLAGS\n  -j, --json             Output one JSON v1 document\n      --live             Probe stored openai-codex credentials live (required)\n      --timeout <ms>     Per-account probe timeout, ${MIN_USAGE_TIMEOUT_MS}-${MAX_USAGE_TIMEOUT_MS} ms (default: ${DEFAULT_USAGE_TIMEOUT_MS})\n  -h, --help             Show this help\n`;
}

export function writeUsageError(
	message: string,
	writeStderr: (value: string) => void = value => process.stderr.write(value),
): void {
	writeStderr(`Error: ${message}\n`);
}

export async function runUsageCommand(
	args: UsageCommandArgs,
	deps: UsageCommandDeps = defaultDeps,
): Promise<UsageJsonV1> {
	if (args.live !== true) throw new Error("usage requires --live");
	if (args.timeoutMs < MIN_USAGE_TIMEOUT_MS || args.timeoutMs > MAX_USAGE_TIMEOUT_MS) {
		throw new Error(`usage timeout must be between ${MIN_USAGE_TIMEOUT_MS} and ${MAX_USAGE_TIMEOUT_MS} ms`);
	}
	const storage = await deps.discoverAuthStorage();
	try {
		const checks = await storage.checkCredentials({ timeoutMs: args.timeoutMs, providers: [USAGE_PROVIDER] });
		const result: UsageJsonV1 = {
			schemaVersion: 1,
			fetchedAt: deps.now(),
			provider: USAGE_PROVIDER,
			live: true,
			accounts: checks.filter(check => check.provider === USAGE_PROVIDER).map(toUsageAccount),
		};
		deps.write(args.json ? `${JSON.stringify(result)}\n` : formatUsageText(result));
		return result;
	} finally {
		storage.close();
	}
}
