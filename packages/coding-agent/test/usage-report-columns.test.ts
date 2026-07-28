import { beforeAll, describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@gajae-code/ai";
import { renderUsageReports } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const NOW = 1_700_000_000_000;

function limit(windowId: string, label: string, windowLabel: string, resetMs: number, fraction: number): UsageLimit {
	return {
		label,
		status: "ok",
		amount: { usedFraction: fraction, unit: "percent" },
		scope: { provider: "anthropic", windowId },
		window: { id: windowId, label: windowLabel, resetsAt: NOW + resetMs },
	} as UsageLimit;
}

function report(email: string, fiveHour: number, sevenDay: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: NOW,
		metadata: { email },
		limits: [
			limit("5h", "Claude 5 Hour", "5 Hour", 2 * 3_600_000, fiveHour),
			limit("7d", "Claude 7 Day", "7 Day", 5 * 86_400_000, sevenDay),
		],
	} as UsageReport;
}

describe("usage report column ordering", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("red-claw");
		if (loaded) setThemeInstance(loaded);
	});

	test("accounts keep the same column across every window", () => {
		// alice has the higher TOTAL usage (0.2 + 0.6) but the lower 5h usage; bob
		// has the higher 5h usage. A per-window sort would put bob first in the 5h
		// row and alice first in the 7d row, so the columns would not line up.
		const reports = [report("alice@example.com", 0.2, 0.6), report("bob@example.com", 0.5, 0.1)];
		const lines = stripAnsi(renderUsageReports(reports, theme, NOW, 100)).split("\n");

		const headerAfter = (titleNeedle: string): string => {
			const titleIdx = lines.findIndex(line => line.includes(titleNeedle));
			expect(titleIdx).toBeGreaterThanOrEqual(0);
			return lines[titleIdx + 1] ?? "";
		};

		for (const header of [headerAfter("Claude 5 Hour"), headerAfter("Claude 7 Day")]) {
			const aliceCol = header.indexOf("alice@example.com");
			const bobCol = header.indexOf("bob@example.com");
			expect(aliceCol).toBeGreaterThanOrEqual(0);
			expect(bobCol).toBeGreaterThanOrEqual(0);
			// Same account order in every window row → columns line up vertically.
			expect(aliceCol).toBeLessThan(bobCol);
		}
	});

	test("renders Kiro subscription balances as separate account rows", () => {
		const kiroReport = (account: string, fraction: number): UsageReport => ({
			provider: "kiro",
			fetchedAt: NOW,
			metadata: { account, subscriptionTitle: "KIRO PRO MAX" },
			limits: [
				{
					id: "kiro:credit",
					label: "Credits",
					status: "ok",
					amount: { usedFraction: fraction, unit: "requests" },
					scope: {
						provider: "kiro",
						accountId: account,
						tier: "KIRO PRO MAX",
						windowId: "billing-cycle",
					},
					window: { id: "billing-cycle", label: "Billing cycle", resetsAt: NOW + 86_400_000 },
				},
			],
		});

		const output = stripAnsi(
			renderUsageReports([kiroReport("kiro builder-id", 0.2), kiroReport("kiro github", 0.4)], theme, NOW, 100),
		);
		const lines = output.split("\n");

		expect(lines.filter(line => line.includes("Credits (KIRO PRO MAX)"))).toHaveLength(2);
		expect(lines.some(line => line.includes("kiro builder-id"))).toBe(true);
		expect(lines.some(line => line.includes("kiro github"))).toBe(true);
		expect(lines.some(line => line.includes("kiro builder-id") && line.includes("kiro github"))).toBe(false);
	});
	test("renders unavailable Kiro accounts as separate error rows", () => {
		const reports: UsageReport[] = [
			{
				provider: "kiro",
				fetchedAt: NOW,
				limits: [],
				metadata: {
					account: "kiro builder-id",
					unavailableReason: "Profile resolution returned HTTP 400",
				},
			},
			{
				provider: "kiro",
				fetchedAt: NOW,
				limits: [],
				metadata: {
					account: "kiro github",
					unavailableReason: "GetUsageLimits returned HTTP 403",
				},
			},
		];

		const output = stripAnsi(renderUsageReports(reports, theme, NOW, 100));

		expect(output).toContain("kiro builder-id -- unavailable: Profile resolution returned HTTP 400");
		expect(output).toContain("kiro github -- unavailable: GetUsageLimits returned HTTP 403");
		expect(output).not.toContain("-- no limits");
		expect(output.indexOf("kiro builder-id")).toBeLessThan(output.indexOf("kiro github"));
	});

	test("keeps identically labelled Kiro credentials in separate rows", () => {
		// Every Builder ID credential carries Kiro CLI's single hardcoded profile
		// ARN, so two Builder ID accounts derive the same label. Grouping on the
		// label would merge their independent balances into one column pair.
		const builderId = (fraction: number): UsageReport => ({
			provider: "kiro",
			fetchedAt: NOW,
			metadata: { account: "kiro builder-id" },
			limits: [
				{
					id: "kiro:credit",
					label: "Credits",
					status: "ok",
					amount: { usedFraction: fraction, unit: "requests" },
					scope: { provider: "kiro", windowId: "billing-cycle" },
					window: { id: "billing-cycle", label: "Billing cycle", resetsAt: NOW + 86_400_000 },
				},
			],
		});

		const lines = stripAnsi(renderUsageReports([builderId(0.1), builderId(0.9)], theme, NOW, 100)).split("\n");
		const headers = lines.filter(line => line.includes("kiro builder-id"));

		// One row per credential, and no row carrying two account columns.
		expect(headers).toHaveLength(2);
		for (const header of headers) {
			expect(header.split("kiro builder-id")).toHaveLength(2);
		}
		expect(lines.filter(line => line.includes("90% free"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("10% free"))).toHaveLength(1);
	});

	test("numbers Kiro accounts that carry no identifying metadata at all", () => {
		// With no email/accountId/account metadata the renderer falls back to
		// positional labels; a fixed index would render every row as "account 1".
		const bare = (reason: string): UsageReport =>
			({
				provider: "kiro",
				fetchedAt: NOW,
				limits: [],
				metadata: { unavailableReason: reason },
			}) as UsageReport;

		const output = stripAnsi(renderUsageReports([bare("HTTP 403"), bare("HTTP 400")], theme, NOW, 100));

		expect(output).toContain("account 1 -- unavailable: HTTP 403");
		expect(output).toContain("account 2 -- unavailable: HTTP 400");
	});

	test("continues positional numbering after limited accounts", () => {
		const limited = report("", 0.5, 0.25);
		limited.provider = "kiro";
		limited.metadata = {};
		for (const entry of limited.limits) entry.scope = { ...entry.scope, provider: "kiro" };
		const unavailable: UsageReport = {
			provider: "kiro",
			fetchedAt: NOW,
			limits: [],
			metadata: { unavailableReason: "HTTP 403" },
		};

		const output = stripAnsi(renderUsageReports([limited, unavailable], theme, NOW, 100));
		expect(output).toContain("account 2 -- unavailable: HTTP 403");
		expect(output).not.toContain("account 1 -- unavailable: HTTP 403");
	});
});
