import { beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import type { Theme } from "../../src/modes/theme/theme";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { GhRunWatchViewDetails } from "../../src/tools/gh";
import { githubToolRenderer } from "../../src/tools/gh-renderer";

const ESC = "\u001b";
const BEL = "\u0007";
const OSC52 = `${ESC}]52;c;cGF5bG9hZA==${BEL}`;
const OSC0 = `${ESC}]0;pwned-title${BEL}`;
const OSC8 = `${ESC}]8;;https://attacker.invalid/track${BEL}`;
const OSC8_END = `${ESC}]8;;${BEL}`;
const ERASE_LINE = `${ESC}[2K`;
const SIXEL = `${ESC}P0qsecret-sixel${ESC}\\`;
const BIDI = "\u202E";

let uiTheme: Theme;

function renderLines(component: { render(width: number): string[] }): string {
	return component.render(160).join("\n");
}

function renderIssue(title: string, body: string): string {
	const text = `# Issue #7: ${title}\n\n## Body\n\n${body}`;
	return renderLines(
		githubToolRenderer.renderResult(
			{ content: [{ type: "text", text }] },
			{ expanded: true, isPartial: false },
			uiTheme,
			{ op: "search_issues", repo: "Owner/Name" },
		),
	);
}

function renderCall(args: {
	op: string;
	query?: string;
	repo?: string;
	branch?: string;
	pr?: string;
	run?: string;
}): string {
	return renderLines(githubToolRenderer.renderCall(args, { expanded: false, isPartial: true }, uiTheme));
}

function assertControlsAbsent(rendered: string): void {
	expect(rendered).not.toContain(`${ESC}]52;`);
	expect(rendered).not.toContain(`${ESC}]0;`);
	expect(rendered).not.toContain(`${ESC}]8;`);
	expect(rendered).not.toContain(ERASE_LINE);
	expect(rendered).not.toContain(`${ESC}P`);
	expect(rendered).not.toContain("cGF5bG9hZA");
	expect(rendered).not.toContain("pwned-title");
	expect(rendered).not.toContain("attacker.invalid");
	expect(rendered).not.toContain("secret-sixel");
	expect(rendered).not.toContain(BIDI);
}

function noRawControls(rendered: string): boolean {
	const withoutColor = rendered.replace(/\u001b\[[0-9;]*m/g, "");
	return !withoutColor.includes(ESC) && !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(withoutColor);
}

describe("githubToolRenderer display", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("red-claw");
		expect(loaded).toBeDefined();
		uiTheme = loaded!;
	});

	it("does not draw a terminal control sequence in a GitHub issue title or body", () => {
		const rendered = renderIssue(
			`Release${OSC52}${ERASE_LINE}${BIDI} notes`,
			`See${OSC0} the${OSC8}link${OSC8_END}${SIXEL} changelog.`,
		);
		assertControlsAbsent(rendered);
		expect(rendered).toContain("Release notes");
		expect(rendered).toContain("See the");
		expect(rendered).toContain("link");
		expect(rendered).toContain("changelog.");
		expect(rendered).toContain("## Body");
		expect(noRawControls(rendered)).toBe(true);
	});

	it("does not draw a terminal control sequence in a GitHub Actions watch line", () => {
		const watch: GhRunWatchViewDetails = {
			mode: "commit",
			state: "completed",
			repo: `attacker/evil${OSC52}`,
			headSha: `abc${OSC52}123def456`,
			note: `queued${OSC8}link${OSC8_END}`,
			runs: [
				{
					id: 42,
					displayTitle: `CI${ERASE_LINE}${OSC0}`,
					branch: `feature/login${OSC0}`,
					jobs: [{ id: 7, name: `build${OSC52}`, conclusion: "failure", status: "completed" }],
				},
			],
			failedLogs: [
				{
					runId: 42,
					workflowName: `CI${OSC0}`,
					jobName: `build${OSC52}`,
					available: true,
					tail: `compile ok\nkept-tail${OSC52}${SIXEL}`,
				},
			],
		};
		const rendered = renderLines(
			githubToolRenderer.renderResult(
				{ content: [{ type: "text", text: "watch" }], details: { watch } },
				{ expanded: true, isPartial: false },
				uiTheme,
			),
		);
		assertControlsAbsent(rendered);
		expect(rendered).toContain("attacker/evil");
		expect(rendered).toContain("abc123def456");
		expect(rendered).toContain("#42");
		expect(rendered).toContain("CI");
		expect(rendered).toContain("feature/login");
		expect(rendered).toContain("build");
		expect(rendered).toContain("queued");
		expect(rendered).toContain("link");
		expect(rendered).toContain("kept-tail");
		expect(rendered).toContain("compile ok");
		expect(noRawControls(rendered)).toBe(true);
	});

	it("does not draw a terminal control sequence in a GitHub search query", () => {
		const rendered = renderCall({
			op: "search_issues",
			query: `Bug${OSC52} fix`,
			repo: `Owner/Name${OSC0}`,
		});
		assertControlsAbsent(rendered);
		expect(rendered).toContain("Bug fix");
		expect(rendered).toContain("Owner/Name");
		expect(rendered).toContain("GitHub Search Issues");
	});

	it("keeps an ordinary GitHub issue title and body", () => {
		const rendered = renderIssue("Release notes", "See the changelog.");
		expect(rendered).toContain("# Issue #7: Release notes");
		expect(rendered).toContain("## Body");
		expect(rendered).toContain("See the changelog.");
		expect(rendered).toContain("Owner/Name");
		expect(rendered).toContain("GitHub Search Issues");
	});

	it("keeps non-ascii letters in a GitHub issue title", () => {
		const rendered = renderIssue("café 릴리스", "본문");
		expect(rendered).toContain("café 릴리스");
		expect(rendered).toContain("본문");
	});

	it("keeps a tab as spaces inside a GitHub issue title", () => {
		const rendered = renderIssue("Release\tnotes", "See the changelog.");
		expect(rendered).toContain("Release");
		expect(rendered).toContain("notes");
		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("See the changelog.");
	});

	it("keeps a line break in a GitHub issue body", () => {
		const rendered = renderIssue("Notes", "First paragraph\r\nSecond paragraph");
		expect(rendered).toContain("Notes");
		expect(rendered).toContain("First paragraph");
		expect(rendered).toContain("Second paragraph");
		const first = rendered.indexOf("First paragraph");
		const second = rendered.indexOf("Second paragraph");
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
	});

	it("keeps surrounding whitespace and letter case in a GitHub repository name", () => {
		const rendered = renderCall({
			op: "repo_view",
			repo: "  Owner/Repo  ",
			branch: "Feature/Login",
		});
		expect(rendered).toContain("  Owner/Repo  ");
		expect(rendered).toContain("Feature/Login");
		expect(rendered).toContain("GitHub Repo");
	});

	it("keeps a slash branch and a backslash branch name", () => {
		const slash = renderCall({ op: "repo_view", repo: "Owner/Name", branch: "feature/login" });
		const windows = renderCall({ op: "repo_view", repo: "Owner/Name", branch: "Feature\\Login" });
		expect(slash).toContain("feature/login");
		expect(windows).toContain("Feature\\Login");
	});

	it("keeps a pull request number and its repository", () => {
		const byNumber = renderCall({ op: "pr_checkout", pr: "482", repo: "Owner/Name" });
		const byUrl = renderCall({
			op: "pr_checkout",
			pr: "https://github.com/Owner/Name/pull/482",
			repo: "Owner/Name",
		});
		expect(byNumber).toContain("#482");
		expect(byNumber).toContain("Owner/Name");
		expect(byUrl).toContain("#482");
		expect(byUrl).toContain("Owner/Name");
	});

	it("keeps an ordinary GitHub Actions watch line", () => {
		const watch: GhRunWatchViewDetails = {
			mode: "commit",
			state: "completed",
			repo: "Owner/Name",
			headSha: "abc123def4567890aaaa",
			note: "all checks finished",
			runs: [
				{
					id: 42,
					workflowName: "CI",
					branch: "feature/login",
					jobs: [{ id: 7, name: "build", conclusion: "success", status: "completed", durationSeconds: 3 }],
				},
			],
			failedLogs: [
				{
					runId: 42,
					workflowName: "CI",
					jobName: "build",
					available: true,
					tail: "compile ok\nkept-tail",
				},
			],
		};
		const rendered = renderLines(
			githubToolRenderer.renderResult(
				{ content: [{ type: "text", text: "watch" }], details: { watch } },
				{ expanded: true, isPartial: false },
				uiTheme,
			),
		);
		expect(rendered).toContain("Owner/Name");
		expect(rendered).toContain("abc123def456");
		expect(rendered).toContain("all checks finished");
		expect(rendered).toContain("CI");
		expect(rendered).toContain("feature/login");
		expect(rendered).toContain("build");
		expect(rendered).toContain("3s");
		expect(rendered).toContain("kept-tail");
	});

	it("draws a GitHub issue title without a raw terminal control", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary", maxLength: 32 }), title => {
				const rendered = renderIssue(title, "Kept body");
				expect(noRawControls(rendered)).toBe(true);
				expect(rendered).toContain("Kept body");
				expect(rendered).toContain("Owner/Name");
			}),
			{ seed: 6772026, numRuns: 64 },
		);
	});

	it("keeps ordinary GitHub issue title characters", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[A-Za-z0-9 .,:/#()-]{1,24}$/), title => {
				const rendered = renderIssue(title, "Kept body");
				expect(rendered).toContain(title);
				expect(rendered).toContain("Kept body");
				expect(rendered).toContain("Owner/Name");
			}),
			{ seed: 6772026, numRuns: 64 },
		);
	});
});
