import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@gajae-code/tui";
import { WelcomeComponent } from "../src/modes/components/welcome";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const originalBuildChannel = process.env.GJC_BUILD_CHANNEL;

afterEach(() => {
	if (originalBuildChannel === undefined) {
		delete process.env.GJC_BUILD_CHANNEL;
	} else {
		process.env.GJC_BUILD_CHANNEL = originalBuildChannel;
	}
});
beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load red-claw theme");
	setThemeInstance(theme);
});

function stripRenderControls(line: string): string {
	return stripVTControlCharacters(line);
}

function renderedColumnWidths(lines: string[]): { left: number; right: number } {
	for (const line of lines.map(stripRenderControls)) {
		const separators = Array.from(line.matchAll(/│/g), match => match.index ?? -1);
		if (separators.length >= 3) {
			const [leftEdge, divider, rightEdge] = separators;
			return {
				left: visibleWidth(line.slice(leftEdge + 1, divider)),
				right: visibleWidth(line.slice(divider + 1, rightEdge)),
			};
		}
	}
	throw new Error("Expected two-column welcome layout");
}

function renderedRightColumn(lines: string[]): string[] {
	return lines.map(stripRenderControls).flatMap(line => {
		const separators = Array.from(line.matchAll(/│/g), match => match.index ?? -1);
		if (separators.length < 3) return [];
		const [, divider, rightEdge] = separators;
		return [line.slice(divider + 1, rightEdge)];
	});
}

function flowKeyContentRows(lines: string[]): string[] {
	const rightColumn = renderedRightColumn(lines);
	const start = rightColumn.findIndex(line => line.includes("Flow keys"));
	const end = rightColumn.findIndex((line, index) => index > start && line.includes("Project pulse"));
	if (start === -1 || end === -1) throw new Error("Expected Flow keys and Project pulse sections");
	return rightColumn.slice(start + 1, end).filter(line => {
		const text = line.trim();
		return text.length > 0 && !/[─━-]{3,}/.test(text);
	});
}

describe("WelcomeComponent viewport sizing", () => {
	it("uses the full terminal width on wide initial forge viewports", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");
		const lines = welcome.render(200);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(200);
		}
	});

	it("renders the build label from metadata instead of defaulting to dev", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			buildLabel: "release build",
		});
		const rendered = welcome.render(120).map(stripRenderControls).join("\n");

		expect(rendered).toContain("gjc v1.2.3 · release build · GJC Forge");
		expect(rendered).not.toContain("dev build");
	});

	it("renders the production metadata resolver label when no override is provided", () => {
		process.env.GJC_BUILD_CHANNEL = "release";
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");
		const rendered = welcome.render(120).map(stripRenderControls).join("\n");

		expect(rendered).toContain("gjc v1.2.3 · release build · GJC Forge");
		expect(rendered).not.toContain("dev build");
	});

	it("splits the forge and details columns evenly on wide viewports", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");
		const columns = renderedColumnWidths(welcome.render(140));

		expect(Math.abs(columns.left - columns.right)).toBeLessThanOrEqual(1);
	});

	it("degrades gracefully on tiny terminal widths", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");

		expect(welcome.render(5).every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(welcome.render(3)).toEqual([]);
		expect(welcome.render(24).every(line => visibleWidth(line) <= 24)).toBe(true);
	});

	it("fills available terminal rows while reserving the pinned composer and HUD", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 24,
			getReservedBottomRows: () => 6,
		});
		const lines = welcome.render(100);

		expect(lines).toHaveLength(18);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		expect(lines.some(line => line.includes("GJC Forge"))).toBe(true);
		expect(lines.some(line => line.includes("What's New"))).toBe(true);
	});
	it("integrates changelog highlights without overflowing narrow CJK content", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 16,
			getReservedBottomRows: () => 5,
			changelogMarkdown: [
				"## [1.2.3]",
				"",
				"### Fixed",
				"",
				"- 한국어와 English가 섞인 긴 업데이트 내용을 시작 화면 안에서 안전하게 줄입니다.",
				"- Added fullscreen startup framing.",
			].join("\n"),
		});
		const lines = welcome.render(60);

		expect(lines).toHaveLength(11);
		expect(lines.some(line => line.includes("한국어와 English"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("expands What's New highlights when the viewport has spare rows", () => {
		const changelogMarkdown = [
			"## [1.2.3]",
			"",
			"### Added",
			"",
			...Array.from({ length: 8 }, (_, index) => `- Dynamic changelog item ${index + 1}`),
		].join("\n");
		const compact = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 24,
			getReservedBottomRows: () => 4,
			changelogMarkdown,
		});
		const roomy = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 40,
			getReservedBottomRows: () => 4,
			changelogMarkdown,
		});

		const compactText = compact.render(100).join("\n");
		const roomyText = roomy.render(100).join("\n");

		expect(compactText).toContain("Dynamic changelog item 1");
		expect(compactText).not.toContain("Dynamic changelog item 4");
		expect(roomyText).toContain("Dynamic changelog item 8");
	});

	it("does not steal rows when the pinned composer already fills the viewport", () => {
		const hidden = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 5,
			getReservedBottomRows: () => 5,
		});
		expect(hidden.render(80)).toEqual([]);

		const oneRow = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 5,
			getReservedBottomRows: () => 4,
		});
		const lines = oneRow.render(80);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(80);
	});

	it("expands the session trail when the viewport has spare rows", () => {
		const recentSessions = Array.from({ length: 8 }, (_, index) => ({
			name: `trail-session-${index + 1}`,
			timeAgo: `${index + 1}m ago`,
		}));
		const compact = new WelcomeComponent("1.2.3", "test-model", "test-provider", recentSessions, [], "ascii", {
			getViewportRows: () => 24,
			getReservedBottomRows: () => 4,
		});
		const roomy = new WelcomeComponent("1.2.3", "test-model", "test-provider", recentSessions, [], "ascii", {
			getViewportRows: () => 40,
			getReservedBottomRows: () => 4,
		});

		const compactText = compact.render(100).join("\n");
		const roomyText = roomy.render(100).join("\n");

		expect(compactText).toContain("trail-session-4");
		expect(compactText).not.toContain("trail-session-5");
		expect(roomyText).toContain("trail-session-8");
	});

	it("packs Flow keys across the available section width", () => {
		const narrow = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			keyDisplayContext: { platform: "linux" },
		});
		const wide = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			keyDisplayContext: { platform: "linux" },
		});

		const narrowFlowRows = flowKeyContentRows(narrow.render(70));
		const wideFlowRows = flowKeyContentRows(wide.render(160));
		const wideText = wideFlowRows.join("\n");

		expect(wideFlowRows.length).toBeLessThan(narrowFlowRows.length);
		expect(wideText).toContain("/ commands");
		expect(wideText).toContain("Ctrl+C clear");
	});

	it.each([
		["darwin", ["⌃L model", "⇧⇥ reasoning", "⇥ complete", "⌃J newline", "⌃C clear"]],
		["win32", ["Ctrl+L model", "Shift+Tab reasoning", "Tab complete", "Alt+Enter newline", "Ctrl+C clear"]],
		["linux", ["Ctrl+L model", "Shift+Tab reasoning", "Tab complete", "Ctrl+J newline", "Ctrl+C clear"]],
	] as const)("renders platform-aware canonical Flow keys for %s", (platform, expected) => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			keyDisplayContext: { platform },
		});
		const flowText = flowKeyContentRows(welcome.render(160)).join("\n");

		let previousIndex = -1;
		for (const label of expected) {
			const index = flowText.indexOf(label);
			expect(index).toBeGreaterThan(previousIndex);
			previousIndex = index;
		}
	});

	it("clips Flow keys to the viewport row budget before session trail rows", () => {
		const recentSessions = Array.from({ length: 6 }, (_, index) => ({
			name: `trail-session-${index + 1}`,
			timeAgo: `${index + 1}m ago`,
		}));
		const compact = new WelcomeComponent("1.2.3", "test-model", "test-provider", recentSessions, [], "ascii", {
			getViewportRows: () => 18,
			getReservedBottomRows: () => 4,
		});

		const lines = compact.render(80);
		const flowRows = flowKeyContentRows(lines);

		expect(lines).toHaveLength(14);
		expect(flowRows.length).toBeLessThanOrEqual(2);
		expect(lines.join("\n")).toContain("/help");
	});
});
