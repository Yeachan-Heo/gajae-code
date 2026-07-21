import { describe, expect, it, vi } from "bun:test";
import type { CredentialHealthResult } from "@gajae-code/ai";
import {
	DEFAULT_USAGE_TIMEOUT_MS,
	MAX_USAGE_TIMEOUT_MS,
	MIN_USAGE_TIMEOUT_MS,
	parseUsageRawArgv,
	runUsageCommand,
	toUsageAccount,
	USAGE_PROVIDER,
} from "../src/cli/usage-cli";

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectKeys(item, keys);
		return keys;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, nested] of Object.entries(value)) {
			keys.add(key);
			collectKeys(nested, keys);
		}
	}
	return keys;
}

describe("parseUsageRawArgv", () => {
	it("accepts only the explicit live Codex usage forms", () => {
		expect(parseUsageRawArgv(["--live"])).toEqual({
			kind: "args",
			args: { json: false, live: true, timeoutMs: DEFAULT_USAGE_TIMEOUT_MS },
		});
		expect(parseUsageRawArgv(["--live", "--json", "--timeout", String(MIN_USAGE_TIMEOUT_MS)])).toEqual({
			kind: "args",
			args: { json: true, live: true, timeoutMs: MIN_USAGE_TIMEOUT_MS },
		});
		expect(parseUsageRawArgv(["-j", "--timeout", String(MAX_USAGE_TIMEOUT_MS), "--live"])).toEqual({
			kind: "args",
			args: { json: true, live: true, timeoutMs: MAX_USAGE_TIMEOUT_MS },
		});
	});

	it("routes standalone help without accepting mixed help", () => {
		expect(parseUsageRawArgv(["--help"])).toEqual({ kind: "help" });
		expect(parseUsageRawArgv(["-h"])).toEqual({ kind: "help" });
		expect(parseUsageRawArgv(["--live", "--help"]).kind).toBe("error");
	});

	it("rejects malformed input before storage discovery can run", () => {
		for (const argv of [
			[],
			["--json"],
			["extra", "--live"],
			["--live", "extra"],
			["--live", "--provider", "anthropic"],
			["--live", "--provider=anthropic"],
			["--live", "--unknown"],
			["--live", "--live"],
			["--live", "--json", "-j"],
			["--live", "--timeout"],
			["--live", "--timeout=1000"],
			["--live", "--timeout", "999"],
			["--live", "--timeout", "30001"],
			["--live", "--timeout", "abc"],
			["--live", "--"],
		] as const) {
			expect(parseUsageRawArgv(argv).kind, argv.join(" ")).toBe("error");
		}
	});
});

describe("usage DTO mapping", () => {
	it("maps credential health to a closed secret-free public DTO", () => {
		const sentinel = "Bearer SECRET_ACCESS_TOKEN.abc.def";
		const health = {
			id: 42,
			provider: USAGE_PROVIDER,
			type: "oauth",
			email: "user@example.com",
			accountId: "acct_123",
			remoteRefresh: true,
			ok: true,
			reason: sentinel,
			report: {
				provider: USAGE_PROVIDER,
				fetchedAt: 123,
				metadata: { accessToken: sentinel, tier: "pro" },
				raw: { refreshToken: sentinel },
				limits: [
					{
						id: "openai-codex:primary",
						label: "7 days",
						scope: { provider: USAGE_PROVIDER, accountId: "acct_123", tier: "pro" },
						window: { id: "7d", label: "7 days", durationMs: 604_800_000, resetsAt: 1_800_000_000_000 },
						amount: {
							unit: "percent",
							used: 18,
							limit: 100,
							remaining: 82,
							usedFraction: 0.18,
							remainingFraction: 0.82,
						},
						status: "ok",
						notes: [sentinel],
					},
				],
			},
		} as unknown as CredentialHealthResult;

		const dto = toUsageAccount(health);
		expect(dto).toEqual({
			identity: { email: "user@example.com", accountId: "acct_123" },
			status: "ok",
			error: null,
			limits: [
				{
					id: "openai-codex:primary",
					label: "7 days",
					status: "ok",
					window: { id: "7d", label: "7 days", durationMs: 604_800_000, resetsAt: 1_800_000_000_000 },
					amount: {
						unit: "percent",
						used: 18,
						limit: 100,
						remaining: 82,
						usedFraction: 0.18,
						remainingFraction: 0.82,
					},
				},
			],
		});
		for (const key of ["type", "remoteRefresh", "reason", "metadata", "raw", "scope", "notes"]) {
			expect(collectKeys(dto).has(key), key).toBe(false);
		}
		expect(JSON.stringify(dto)).not.toContain("42");
		expect(JSON.stringify(dto)).not.toContain("SECRET_ACCESS_TOKEN");
	});

	it("maps failed and unavailable probes to deterministic public errors", () => {
		expect(
			toUsageAccount({ provider: USAGE_PROVIDER, id: 1, type: "oauth", ok: false, reason: "401 token" }),
		).toEqual({
			identity: { email: null, accountId: null },
			status: "error",
			error: "probe_failed",
			limits: [],
		});
		expect(toUsageAccount({ provider: USAGE_PROVIDER, id: 2, type: "oauth", ok: null })).toEqual({
			identity: { email: null, accountId: null },
			status: "unavailable",
			error: "probe_unavailable",
			limits: [],
		});
	});
});

describe("runUsageCommand", () => {
	it("checks only openai-codex credentials and closes storage", async () => {
		const write = vi.fn();
		const close = vi.fn();
		const checkCredentials = vi.fn().mockResolvedValue([]);
		const discoverAuthStorage = vi.fn().mockResolvedValue({ checkCredentials, close });

		const result = await runUsageCommand(
			{ json: true, live: true, timeoutMs: 1_500 },
			{ discoverAuthStorage, now: () => 99, write },
		);

		expect(result).toEqual({ schemaVersion: 1, fetchedAt: 99, provider: USAGE_PROVIDER, live: true, accounts: [] });
		expect(checkCredentials).toHaveBeenCalledWith({ timeoutMs: 1_500, providers: [USAGE_PROVIDER] });
		expect(write).toHaveBeenCalledWith(`${JSON.stringify(result)}\n`);
		expect(close).toHaveBeenCalledTimes(1);
	});
});
