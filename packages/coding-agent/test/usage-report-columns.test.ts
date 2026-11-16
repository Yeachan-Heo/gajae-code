import { beforeAll, describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@gajae-code/ai";
import { renderUsageReports } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	collectCachedUsageReports,
	formatLimitDetail,
} from "@gajae-code/coding-agent/slash-commands/helpers/usage-report";

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

/**
 * A report that only carries one window of a pool — the shape Antigravity
 * returns when `fetchAvailableModels` reports just the bottleneck window and
 * the quota-summary call fails — must not vanish from the sibling window row.
 */
function singleWindowReport(email: string, windowId: "5h" | "7d", usedFraction: number): UsageReport {
	const fiveHour = windowId === "5h";
	return {
		provider: "anthropic",
		fetchedAt: NOW,
		metadata: { email },
		limits: [
			{
				...limit(
					windowId,
					fiveHour ? "Claude 5 Hour" : "Claude 7 Day",
					fiveHour ? "5 Hour" : "7 Day",
					(fiveHour ? 2 : 5) * 3_600_000,
					usedFraction,
				),
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
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

	test("collectCachedUsageReports forwards inventory identity when cached report metadata was stripped", () => {
		const strippedReport: UsageReport = {
			provider: "google-antigravity",
			fetchedAt: NOW,
			limits: [
				{
					id: "gemini-3-flash:default:5h",
					label: "Gemini",
					scope: { provider: "google-antigravity", modelId: "gemini-3-flash", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000, resetsAt: NOW + 2 * 3_600_000 },
					amount: {
						unit: "percent",
						usedFraction: 0.25,
						remainingFraction: 0.75,
						used: 25,
						remaining: 75,
						limit: 100,
					},
					status: "ok",
				},
			],
		};
		const runtime = {
			session: {
				sessionId: "sess-1",
				credentialSessionId: "sess-1",
				modelRegistry: {
					getAvailable: () => [{ provider: "google-antigravity" }],
					getProviderBaseUrl: () => undefined,
					getAuthStorageOwner: () => undefined,
					authStorage: {
						getGeneration: () => 1,
						hasConfigApiKey: () => false,
						listCredentialInventory: () => [
							{
								id: 51,
								provider: "google-antigravity",
								credentialType: "oauth",
								disabled: false,
								disabledCause: null,
								identityLabel: "byteworx71@gmail.com",
								oauthIdentity: { label: "byteworx71@gmail.com" },
							},
						],
						getCachedCredentialHealth: () => ({ status: "ok", reason: null }),
						getCachedUsageReport: () => ({
							report: strippedReport,
							fetchedAt: NOW,
							freshUntil: NOW + 60_000,
							retainUntil: NOW + 3_600_000,
							freshness: "fresh",
						}),
						getSessionCredentialRowId: () => 51,
						getSelectedOAuthCredentialRowId: () => 51,
						getPreferredOAuthCredentialRowId: () => undefined,
						getSelectedApiKeyCredentialRowId: () => undefined,
						getProspectiveApiKeyCredentialRowId: () => undefined,
						hasRuntimeApiKey: () => false,
						getEffectiveCredentialType: () => "oauth",
						hasLiteralConfigApiKey: () => false,
						isConfigApiKeyUsable: () => undefined,
					},
				},
			},
		};
		const collected = collectCachedUsageReports(runtime as never);
		expect(collected).toHaveLength(1);
		expect(collected[0]?.metadata?.email).toBe("byteworx71@gmail.com");
		const rendered = stripAnsi(renderUsageReports(collected, theme, NOW, 100));
		// The account column shows the address's local part when the whole address does not fit (truncateAccountLabels).
		expect(rendered).toContain("byteworx71");
		expect(rendered).not.toContain("account 1");
	});
});

describe("usage report sibling-window gaps", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("red-claw");
		if (loaded) setThemeInstance(loaded);
	});

	function rows(lines: string[], titleNeedle: string): { title: string; header: string; bars: string } {
		const titleIndex = lines.findIndex(line => line.includes(titleNeedle));
		expect(titleIndex).toBeGreaterThanOrEqual(0);
		return {
			title: lines[titleIndex] ?? "",
			header: lines[titleIndex + 1] ?? "",
			bars: lines[titleIndex + 2] ?? "",
		};
	}

	test("accounts reporting only one window keep their column in the sibling row", () => {
		// bob only reports 5h and carol only reports 7d, which is what a partial
		// Antigravity fetch produces when the quota summary call fails and
		// fetchAvailableModels only surfaces each pool's bottleneck window.
		const reports = [
			report("alice@example.com", 0.2, 1),
			singleWindowReport("bob@example.com", "5h", 0.5),
			singleWindowReport("carol@example.com", "7d", 1),
		];
		const lines = stripAnsi(renderUsageReports(reports, theme, NOW, 160)).split("\n");

		const fiveHour = rows(lines, "Claude 5 Hour");
		const sevenDay = rows(lines, "Claude 7 Day");

		// Every account keeps a column in both rows, in the same order.
		for (const header of [fiveHour.header, sevenDay.header]) {
			const alice = header.indexOf("alice@example.com");
			const carol = header.indexOf("carol@example.com");
			const bob = header.indexOf("bob@example.com");
			expect(alice).toBeGreaterThanOrEqual(0);
			expect(carol).toBeGreaterThan(alice);
			expect(bob).toBeGreaterThan(carol);
		}

		// bob's missing 7d window renders as the existing unknown bar, not a dropped column.
		expect(sevenDay.bars).toContain("·");
		expect(sevenDay.bars).toContain("0% free · 1 not reported");
		expect(sevenDay.title.trimStart().startsWith(theme.status.warning)).toBe(true);

		// 5h: alice 0.2 used, bob 0.5 used → (0.8 + 0.5) / 2 = 65% free; carol is not reported.
		expect(fiveHour.bars).toContain("·");
		expect(fiveHour.bars).toContain("65% free · 1 not reported");
		expect(fiveHour.title.trimStart().startsWith(theme.status.success)).toBe(true);
	});

	test("a sibling window of another pool does not count as reported", () => {
		const mixed = {
			provider: "anthropic",
			fetchedAt: NOW,
			metadata: { email: "erin@example.com" },
			limits: [limit("5h", "Pool A", "5 Hour", 3_600_000, 0.3), limit("7d", "Pool B", "7 Day", 86_400_000, 0.5)],
		} as UsageReport;
		const complete = {
			provider: "anthropic",
			fetchedAt: NOW,
			metadata: { email: "frank@example.com" },
			limits: [limit("5h", "Pool A", "5 Hour", 3_600_000, 0.4), limit("7d", "Pool A", "7 Day", 86_400_000, 0.6)],
		} as UsageReport;
		const lines = stripAnsi(renderUsageReports([mixed, complete], theme, NOW, 160)).split("\n");

		const poolASevenDay = rows(lines, "Pool A (7 Day)");
		expect(poolASevenDay.header).toContain("erin@example.com");
		expect(poolASevenDay.header).toContain("frank@example.com");
		expect(poolASevenDay.bars).toContain("1 not reported");
	});

	test("a window with no sibling reports does not invent the missing row", () => {
		const output = stripAnsi(
			renderUsageReports([singleWindowReport("dave@example.com", "7d", 0.1)], theme, NOW, 100),
		);
		expect(output).toContain("Claude 7 Day");
		expect(output).not.toContain("Claude 5 Hour");
		expect(output).not.toContain("not reported");
	});
});
