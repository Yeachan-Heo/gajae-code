import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@gajae-code/tui";
import { getProjectDir, setProjectDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { StatusLineSegmentId } from "../src/config/settings-schema";
import { StatusLineComponent } from "../src/modes/components/status-line";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme, theme } from "../src/modes/theme/theme";
import { getSessionAccentAnsi, getSessionAccentHex } from "../src/utils/session-color";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

/** Minimal SegmentContext factory — only path/git fields matter for these tests. */
function createCtx(overrides?: { pathMaxLength?: number; branch?: string | null }): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {
			path: {
				abbreviate: false,
				maxLength: overrides?.pathMaxLength ?? 40,
				stripWorkPrefix: false,
			},
		},
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: {
			branch: overrides?.branch ?? null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

function createStatusLineSession(sessionName: string) {
	return {
		state: { messages: [] },
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

describe("status line session accent", () => {
	function buildComponent(sessionAccent: boolean) {
		const component = new StatusLineComponent(createStatusLineSession("Named session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["gajae"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent,
		});
		return component;
	}

	const accentAnsi = getSessionAccentAnsi(getSessionAccentHex("Named session"));

	it("paints the gap with the session accent when enabled", () => {
		expect(accentAnsi).toBeDefined();
		const border = buildComponent(true).getTopBorder(80).content;
		expect(border).toContain(`${accentAnsi}${theme.boxRound.horizontal}`);
	});

	it("paints the gap with the border color and omits the session accent when disabled", () => {
		expect(accentAnsi).toBeDefined();
		const border = buildComponent(false).getTopBorder(80).content;
		// Positive: gap is rendered with the theme border color.
		expect(border).toContain(`${theme.getFgAnsi("border")}${theme.boxRound.horizontal}`);
		// Negative: the gap-painting pattern (accent ANSI directly followed by a horizontal
		// glyph) must not appear. The session_name segment may still emit the accent ANSI
		// for its own text — we only care that the gap is not accent-painted.
		expect(border).not.toContain(`${accentAnsi}${theme.boxRound.horizontal}`);
	});
});
describe("status line preview highlight", () => {
	it("clears transient highlight when later settings omit it", () => {
		const component = new StatusLineComponent(createStatusLineSession("Highlight session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["gajae"],
			rightSegments: [],
			separator: "powerline-thin",
			previewHighlightSegment: "gajae",
		});

		expect(component.getTopBorder(80).content).toContain("\x1b[7m");

		component.updateSettings({ separator: "pipe" });

		expect(component.getTopBorder(80).content).not.toContain("\x1b[7m");
	});
});

describe("status line version display", () => {
	function buildComponent(widthVersion: string = "9.8.7") {
		const component = new StatusLineComponent(createStatusLineSession("Version session"), { version: widthVersion });
		component.updateSettings({
			preset: "custom",
			leftSegments: ["gajae"],
			rightSegments: ["model"],
			separator: "powerline-thin",
			showSkillHud: false,
		});
		return component;
	}

	it("shows the current version in the active status line", () => {
		const lines = buildComponent().render(100);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("v9.8.7");
	});

	it("drops the low-priority version before overflowing narrow terminals", () => {
		const lines = buildComponent().render(12);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(12);
		expect(lines[0]).not.toContain("v9.8.7");
	});
});

describe("path segment truncation at varying maxLength", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-overflow-very-long-directory-name-for-testing-"));
		setProjectDir(tmpDir);
	});

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		const full = renderSegment("path", createCtx({ pathMaxLength: 200 }));
		const short = renderSegment("path", createCtx({ pathMaxLength: 10 }));

		expect(full.visible).toBe(true);
		expect(short.visible).toBe(true);
		expect(visibleWidth(short.content)).toBeLessThan(visibleWidth(full.content));
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLen => {
			const rendered = renderSegment("path", createCtx({ pathMaxLength: maxLen }));
			return visibleWidth(rendered.content);
		});

		for (let i = 1; i < widths.length; i++) {
			expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
		}
	});

	it("still renders a visible segment at maxLength=4", () => {
		const rendered = renderSegment("path", createCtx({ pathMaxLength: 4 }));
		expect(rendered.visible).toBe(true);
		expect(visibleWidth(rendered.content)).toBeGreaterThan(0);
	});
});

describe("overflow: path shrinks before git is dropped", () => {
	let tmpDir: string;

	beforeAll(() => {
		// Long dir name guarantees the path segment is wide
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-overflow-a-very-long-worktree-directory-name-here-"));
		setProjectDir(tmpDir);
	});

	/**
	 * Simulates the overflow algorithm from #buildStatusLine:
	 * render left segments, then shrink path before popping, same as production code.
	 */
	function simulateOverflow(
		width: number,
		leftSegmentIds: StatusLineSegmentId[],
		ctx: SegmentContext,
	): { surviving: StatusLineSegmentId[]; contents: string[] } {
		const left: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of leftSegmentIds) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				left.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		// Simplified groupWidth: sum of visible widths + padding between segments
		const groupWidth = () => {
			if (left.length === 0) return 0;
			const partsWidth = left.reduce((sum, p) => sum + visibleWidth(p), 0);
			// Each separator gap ~ 3 chars, plus 2 for outer padding
			return partsWidth + Math.max(0, left.length - 1) * 3 + 2;
		};

		// Path shrink step (mirrors production code)
		const pathIdx = leftSegIds.indexOf("path");
		if (pathIdx >= 0 && groupWidth() > width) {
			const overflow = groupWidth() - width;
			const currentPathVW = visibleWidth(left[pathIdx]);
			const minPathVW = 8;
			const shrinkable = currentPathVW - minPathVW;
			if (shrinkable > 0) {
				const shrinkBy = Math.min(shrinkable, overflow);
				const currentMaxLen = ctx.options.path?.maxLength ?? 40;
				let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
				const pathCtx = (maxLen: number): SegmentContext => ({
					...ctx,
					options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
				});
				let reRendered = renderSegment("path", pathCtx(newMaxLen));
				if (reRendered.visible && reRendered.content) {
					for (let i = 0; i < 8; i++) {
						const saved = currentPathVW - visibleWidth(reRendered.content);
						if (saved >= shrinkBy) break;
						const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
						if (nextMaxLen >= newMaxLen) break;
						newMaxLen = nextMaxLen;
						const adjusted = renderSegment("path", pathCtx(newMaxLen));
						if (!adjusted.visible || !adjusted.content) break;
						reRendered = adjusted;
					}
					left[pathIdx] = reRendered.content;
				}
			}
		}

		// Left-pop loop (fallback)
		while (groupWidth() > width && left.length > 0) {
			left.pop();
			leftSegIds.pop();
		}

		return { surviving: [...leftSegIds], contents: [...left] };
	}

	it("keeps git segment when path can be shrunk to fit", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "feat/long-branch-name" });
		// Use a width that's tight but should fit both after path shrinks
		const fullPath = renderSegment("path", ctx);
		const fullGit = renderSegment("git", ctx);
		const bothWidth = visibleWidth(fullPath.content) + visibleWidth(fullGit.content);
		// Set width to ~60% of both segments — forces shrink but should keep both
		const tightWidth = Math.floor(bothWidth * 0.6) + 10;

		const result = simulateOverflow(tightWidth, ["path", "git"], ctx);

		expect(result.surviving).toContain("git");
		expect(result.surviving).toContain("path");
	});

	it("drops git only when terminal is extremely narrow", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "main" });
		// Absurdly narrow — even minimally-truncated path won't fit with git
		const result = simulateOverflow(5, ["path", "git"], ctx);

		// At 5 columns, nothing fits
		expect(result.surviving.length).toBeLessThanOrEqual(1);
	});

	it("is a no-op when there is enough space", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "main" });
		const result = simulateOverflow(200, ["path", "git"], ctx);

		expect(result.surviving).toEqual(["path", "git"]);
	});

	it("shrinks a short path when maxLength exceeds actual path length", () => {
		// Short dir name — rendered path is well under maxLength=80
		const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-short-"));
		setProjectDir(shortDir);
		try {
			const ctx = createCtx({ pathMaxLength: 80, branch: "feat/long-branch-name" });
			const fullPath = renderSegment("path", ctx);
			const fullGit = renderSegment("git", ctx);
			const pathVW = visibleWidth(fullPath.content);
			const gitVW = visibleWidth(fullGit.content);

			// Sanity: path is shorter than maxLength — this is the bug scenario
			expect(pathVW).toBeLessThan(80);

			// Width that fits a shrunken path + git but not the full path + git
			const tightWidth = Math.floor(pathVW * 0.5) + gitVW + 10;

			const result = simulateOverflow(tightWidth, ["path", "git"], ctx);

			expect(result.surviving).toContain("path");
			expect(result.surviving).toContain("git");
		} finally {
			// Restore for other tests
			setProjectDir(tmpDir);
		}
	});
	it("preserves git when overflow is only 1-2 columns", () => {
		const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-narrow-ovf-"));
		setProjectDir(shortDir);
		try {
			const ctx = createCtx({ pathMaxLength: 80, branch: "main" });
			const fullPath = renderSegment("path", ctx);
			const fullGit = renderSegment("git", ctx);
			const pathVW = visibleWidth(fullPath.content);
			const gitVW = visibleWidth(fullGit.content);

			// Compute exact full width using the test's groupWidth formula:
			// partsWidth + (numParts - 1) * 3 + 2
			const fullWidth = pathVW + gitVW + (2 - 1) * 3 + 2;

			// Overflow by exactly 2 columns — the scenario the single-pass missed
			const result = simulateOverflow(fullWidth - 2, ["path", "git"], ctx);

			expect(result.surviving).toContain("path");
			expect(result.surviving).toContain("git");

			// Path must have actually shrunk (proves the loop ran)
			const shrunkPathVW = visibleWidth(result.contents[result.surviving.indexOf("path")]);
			expect(shrunkPathVW).toBeLessThan(pathVW);
		} finally {
			setProjectDir(tmpDir);
		}
	});
});

describe("status line multi-row wrapping (statusLine.maxRows)", () => {
	const LONG_NAME = "WrapSess1";

	function buildComponent(maxRows: number): StatusLineComponent {
		const component = new StatusLineComponent(createStatusLineSession(LONG_NAME));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["gajae", "session"],
			rightSegments: ["session_name", "time"],
			separator: "pipe",
			showSkillHud: false,
			sessionAccent: false,
			maxRows,
		});
		return component;
	}

	const strip = (s: string): string => Bun.stripANSI(s);

	it("keeps the polished single row when everything fits", () => {
		const lines = buildComponent(2).render(200);
		expect(lines).toHaveLength(1);
	});

	it("wraps overflow onto extra rows instead of dropping segments", () => {
		const single = buildComponent(1).render(24);
		expect(single).toHaveLength(1);

		const wrapped = buildComponent(2).render(24);
		expect(wrapped.length).toBeGreaterThan(1);
		// Every emitted row stays within the terminal width.
		for (const row of wrapped) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(24);
		}
		// Wrapping preserves content that the single-row layout would have dropped.
		const singleLen = strip(single[0]).length;
		const wrappedLen = wrapped.reduce((sum, row) => sum + strip(row).length, 0);
		expect(wrappedLen).toBeGreaterThan(singleLen);
		// The session name survives across the wrapped rows.
		expect(wrapped.some(row => strip(row).includes(LONG_NAME))).toBe(true);
	});

	it("caps wrapping at maxRows", () => {
		const wrapped = buildComponent(2).render(8);
		expect(wrapped.length).toBeLessThanOrEqual(2);
	});

	it("allows up to three rows when maxRows is 3", () => {
		const two = buildComponent(2).render(8);
		const three = buildComponent(3).render(8);
		expect(three.length).toBeLessThanOrEqual(3);
		// A tighter cap keeps strictly fewer-or-equal rows than a looser cap.
		expect(three.length).toBeGreaterThanOrEqual(two.length);
	});

	it("getPreviewContent stacks wrapped rows with newlines", () => {
		const component = buildComponent(2);
		const preview = component.getPreviewContent(24);
		expect(preview.split("\n").length).toBeGreaterThan(1);
		// maxRows=1 preview stays a single line.
		expect(buildComponent(1).getPreviewContent(24).split("\n")).toHaveLength(1);
	});
});
