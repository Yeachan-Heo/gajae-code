import { beforeAll, describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@gajae-code/ai";
import { renderUsageReports } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { formatLimitDetail } from "@gajae-code/coding-agent/slash-commands/helpers/usage-report";

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

	test("multiple windows from one unidentified report keep one fallback account label", () => {
		const hybridReport = {
			provider: "grok-build",
			fetchedAt: NOW,
			metadata: {},
			limits: [
				{
					...limit("7d", "SuperGrok monthly credits", "Monthly credits", 20 * 86_400_000, 0.25),
					scope: { provider: "grok-build", windowId: "7d" },
				},
				{
					...limit("weekly", "SuperGrok weekly credits", "Weekly", 6 * 86_400_000, 0.06),
					scope: { provider: "grok-build", windowId: "weekly" },
				},
			],
		} as UsageReport;

		const output = stripAnsi(renderUsageReports([hybridReport], theme, NOW, 100));

		expect(output.match(/account 1/g)).toHaveLength(2);
		expect(output).not.toContain("account 2");
	});

	test("unidentified hybrid reports keep distinct identities across every window", () => {
		const hybridReport = (monthly: number, weekly: number): UsageReport =>
			({
				provider: "grok-build",
				fetchedAt: NOW,
				metadata: {},
				limits: [
					{
						...limit("7d", "SuperGrok monthly credits", "Monthly credits", 20 * 86_400_000, monthly),
						scope: { provider: "grok-build", windowId: "7d" },
					},
					{
						...limit("weekly", "SuperGrok weekly credits", "Weekly", 6 * 86_400_000, weekly),
						scope: { provider: "grok-build", windowId: "weekly" },
					},
				],
			}) as UsageReport;
		const lines = stripAnsi(
			renderUsageReports([hybridReport(0.1, 0.2), hybridReport(0.8, 0.7)], theme, NOW, 100),
		).split("\n");

		const headerAfter = (titleNeedle: string): string => {
			const titleIndex = lines.findIndex(line => line.includes(titleNeedle));
			expect(titleIndex).toBeGreaterThanOrEqual(0);
			return lines[titleIndex + 1] ?? "";
		};
		for (const header of [headerAfter("SuperGrok monthly credits"), headerAfter("SuperGrok weekly credits")]) {
			expect(header.match(/account 1/g)).toHaveLength(1);
			expect(header.match(/account 2/g)).toHaveLength(1);
		}
	});
});

describe("usage report reset visibility", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("red-claw");
		if (loaded) setThemeInstance(loaded);
	});

	test("multi-account windows still render a reset line", () => {
		const reports = [report("alice@example.com", 0.2, 0.6), report("bob@example.com", 0.5, 0.1)];
		const output = stripAnsi(renderUsageReports(reports, theme, NOW, 100));

		expect(output.match(/resets in /g)).toHaveLength(2);
	});

	test("divergent resets render a range, identical resets render one value", () => {
		const skewed = {
			...report("carol@example.com", 0.3, 0.3),
			limits: [
				limit("5h", "Claude 5 Hour", "5 Hour", 4 * 3_600_000, 0.3),
				limit("7d", "Claude 7 Day", "7 Day", 5 * 86_400_000, 0.3),
			],
		} as UsageReport;
		const lines = stripAnsi(renderUsageReports([report("alice@example.com", 0.2, 0.6), skewed], theme, NOW, 100))
			.split("\n")
			.filter(line => line.includes("resets in "));

		expect(lines).toHaveLength(2);
		// 5h window: alice resets in 2h, carol in 4h → a range.
		expect(lines[0]).toMatch(/resets in 2h–4h \(first .+\)/);
		// 7d window: both reset at the same instant → a single value.
		expect(lines[1]).toMatch(/^\s*resets in 5d \(.+\)$/);
	});

	test("windows past 48h keep hour precision instead of collapsing to one unit", () => {
		const coarse = {
			...report("dave@example.com", 0.1, 0.1),
			limits: [limit("7d", "Claude 7 Day", "7 Day", 6 * 86_400_000 + 14 * 3_600_000, 0.1)],
		} as UsageReport;
		const output = stripAnsi(renderUsageReports([coarse], theme, NOW, 100));

		expect(output).toContain("resets in 6d 14h");
	});

	test("account labels stay distinguishable when columns are tight", () => {
		const crowded = ["one", "two", "three", "four", "five"].map(name =>
			report(`${name}.longlocalpart@example.com`, 0.2, 0.2),
		);
		const lines = stripAnsi(renderUsageReports(crowded, theme, NOW, 80)).split("\n");
		const header = lines[lines.findIndex(line => line.includes("Claude 5 Hour")) + 1] ?? "";
		// Strip the shared `(reset)` suffix so uniqueness is judged on identity alone.
		const labels = header
			.trim()
			.split(/\s*\([^)]*\)\s*/)
			.map(cell => cell.trim())
			.filter(Boolean);

		expect(labels).toHaveLength(crowded.length);
		expect(new Set(labels).size).toBe(crowded.length);
	});
});

describe("usage text rows", () => {
	test("limit lines carry the reset countdown and an absolute reset time", () => {
		const weekly = limit("7d", "Claude 7 Day", "7 Day", 6 * 86_400_000 + 14 * 3_600_000, 0.24);
		const detail = formatLimitDetail(weekly, NOW);

		expect(detail).toContain("24.00% used");
		expect(detail).toContain("resets in 6d 14h");
	});

	test("expired or missing reset windows add no reset text", () => {
		const past = limit("5h", "Claude 5 Hour", "5 Hour", -3_600_000, 0.5);
		const windowless = { ...past, window: undefined } as UsageLimit;

		expect(formatLimitDetail(past, NOW)).not.toContain("resets in");
		expect(formatLimitDetail(windowless, NOW)).not.toContain("resets in");
	});
});
