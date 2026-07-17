import { type Component, padding, TERMINAL, truncateToWidth, visibleWidth } from "@gajae-code/tui";
import { APP_NAME } from "@gajae-code/utils";
import { formatBuildLabel } from "../../build-metadata";
import { type ThemeColor, theme } from "../../modes/theme/theme";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "idle" | "ready" | "error" | "connecting";
	fileTypes: string[];
}

export type WelcomeLogoMode = "unicode" | "square" | "ascii";
export interface WelcomeComponentOptions {
	getViewportRows?: () => number | undefined;
	getReservedBottomRows?: (termWidth: number) => number;
	changelogMarkdown?: string;
	collapseChangelog?: boolean;
	buildLabel?: string;
}

const WELCOME_STATIC_RIGHT_ROWS_EXCLUDING_DYNAMIC_SECTIONS = 9;
const DEFAULT_WHATS_NEW_ROWS = 3;
const MAX_WHATS_NEW_ROWS = 12;
const NEWLINE_FLOW_KEY =
	process.platform === "win32" ? { key: "alt+enter", label: "newline" } : { key: "ctrl+j", label: "newline" };

const FLOW_KEY_ITEMS: ReadonlyArray<{ key: string; label: string }> = [
	{ key: "/", label: "commands" },
	{ key: "#", label: "actions" },
	{ key: "!", label: "shell" },
	{ key: "$", label: "python" },
	{ key: "?", label: "keymap" },
	{ key: "ctrl+l", label: "model" },
	{ key: "shift+tab", label: "reasoning" },
	{ key: "tab", label: "complete" },
	NEWLINE_FLOW_KEY,
	{ key: "ctrl+c", label: "clear" },
];

/**
 * GJC-native launch surface with compact command affordances, project
 * signals, and a claw/talon mark without copying another agent shell.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
		private readonly logoMode: WelcomeLogoMode = "unicode",
		private readonly options: WelcomeComponentOptions = {},
	) {}

	invalidate(): void {}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
		this.#animTimer.unref?.();
	}

	dispose(): void {
		this.#stopAnimation();
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		const boxWidth = Math.max(0, termWidth);
		if (boxWidth < 4) {
			return [];
		}

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) {
			return [];
		}
		const targetContentRows = targetRows === undefined ? undefined : Math.max(0, targetRows - 2);
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const minLeftCol = 20; // logo mark plus GJC identity labels
		const minRightCol = 24;
		const modelPill = this.#pill(theme.icon.model || "model", this.modelName, "statusLineModel");
		const providerPill = this.#pill(theme.icon.package || "provider", this.providerName, "statusLinePath");
		const logoLines = this.#logoLines();
		const logoMinWidth = Math.max(...logoLines.map(line => visibleWidth(line)));
		const leftMinContentWidth = Math.max(
			minLeftCol,
			logoMinWidth,
			visibleWidth("GJC Forge"),
			visibleWidth("shape · act · prove"),
			visibleWidth(modelPill),
			visibleWidth(providerPill),
		);
		const evenLeftCol = Math.floor(dualContentWidth / 2);
		const maxLeftColWithRightMinimum = Math.max(1, dualContentWidth - minRightCol);
		const desiredLeftCol = Math.max(leftMinContentWidth, evenLeftCol);
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, maxLeftColWithRightMinimum)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		const logoColored = this.#currentLogoFrame(logoLines);

		const leftLines = [
			"",
			this.#centerText(theme.bold(theme.fg("accent", "GJC Forge")), leftCol),
			this.#centerText(theme.fg("dim", "shape · act · prove"), leftCol),
			"",
			...logoColored.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(this.#loadingLine(), leftCol),
			this.#centerText(modelPill, leftCol),
			this.#centerText(providerPill, leftCol),
			"",
		];

		const buildSeparator = (columnWidth: number): string =>
			` ${theme.fg("dim", theme.boxRound.horizontal.repeat(Math.max(0, columnWidth - 2)))}`;

		const rightColumnWidth = showRightColumn ? rightCol : leftCol;
		const separator = buildSeparator(rightColumnWidth);
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers.slice(0, 4)) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.success", "success")
						: server.status === "error"
							? theme.styledSymbol("status.error", "error")
							: theme.styledSymbol("status.pending", "muted");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}

		const flowPreferredRows = this.#flowKeyRows(rightColumnWidth).length;
		const changelogRowLimit = this.#whatsNewRowLimit(targetContentRows, lspLines.length, flowPreferredRows);
		const changelogLines = this.#whatsNewLines(rightColumnWidth, changelogRowLimit);
		const flowRowLimit = this.#flowKeyRowLimit(
			targetContentRows,
			changelogLines.length,
			lspLines.length,
			rightColumnWidth,
		);
		const flowLines = this.#flowKeyLines(rightColumnWidth, flowRowLimit);
		const sessionLimit = this.#sessionTrailLimit(
			targetContentRows,
			changelogLines.length,
			lspLines.length,
			flowLines.length,
		);
		const sessionLines = this.#sessionTrailLines(rightColumnWidth, sessionLimit);

		const rightLines = [
			"",
			` ${theme.bold(theme.fg("accent", "What's New"))}`,
			...changelogLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Flow keys"))}`,
			...flowLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Project pulse"))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Session trail"))}`,
			...sessionLines,
			"",
		];

		const contentRows =
			targetContentRows ??
			(showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length + rightLines.length);
		const outputRows = targetRows === undefined ? Math.max(3, contentRows + 2) : targetRows;
		const bodyRows = Math.max(0, outputRows - 2);

		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const lines: string[] = [];
		const buildLabel = this.options.buildLabel ?? formatBuildLabel();
		const title = ` ${APP_NAME} v${this.version} · ${buildLabel} · GJC Forge `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
		}
		if (outputRows === 1) {
			return lines;
		}

		if (showRightColumn) {
			const leftBlock = this.#fitBlock(leftLines, bodyRows, "center");
			const rightBlock = this.#fitBlock(rightLines, bodyRows, "top");
			for (let i = 0; i < bodyRows; i++) {
				const left = this.#fitToWidth(leftBlock[i] ?? "", leftCol);
				const right = this.#fitToWidth(rightBlock[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			}
			lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxSharp.teeUp) + h.repeat(rightCol) + br);
		} else {
			const compactLeftLines =
				bodyRows < 14
					? [
							this.#centerText(theme.bold(theme.fg("accent", "GJC Forge")), leftCol),
							this.#centerText(this.#loadingLine(), leftCol),
							this.#centerText(modelPill, leftCol),
						]
					: leftLines;
			const singleBlock = this.#fitBlock([...compactLeftLines, separator, ...rightLines], bodyRows, "top");
			for (let i = 0; i < bodyRows; i++) {
				lines.push(v + this.#fitToWidth(singleBlock[i] ?? "", leftCol) + v);
			}
			lines.push(bl + h.repeat(leftCol) + br);
		}

		return lines;
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with native ANSI/wide-glyph truncation and padding. */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			return truncateToWidth(str, width, null, true);
		}
		return str + padding(width - visLen);
	}
	#targetRows(termWidth: number): number | undefined {
		const viewportRows = this.options.getViewportRows?.();
		if (typeof viewportRows !== "number" || !Number.isFinite(viewportRows) || viewportRows <= 0) {
			return undefined;
		}
		const reservedRows = Math.max(0, Math.floor(this.options.getReservedBottomRows?.(termWidth) ?? 0));
		return Math.max(0, Math.floor(viewportRows) - reservedRows);
	}

	#loadingLine(): string {
		const frames = theme.spinnerFrames;
		const elapsed = this.#animStart == null ? 0 : performance.now() - this.#animStart;
		const frame = frames.length > 0 ? (frames[Math.floor(elapsed / 100) % frames.length] ?? "*") : "*";
		const label = this.#animStart == null ? "ready" : "warming workspace";
		return `${theme.fg("warning", frame)} ${theme.fg("muted", label)}`;
	}

	#fitBlock(lines: string[], rows: number, align: "top" | "center"): string[] {
		if (rows <= 0) return [];
		const clipped =
			lines.length > rows
				? rows === 1
					? [theme.fg("dim", " …")]
					: [...lines.slice(0, rows - 1), theme.fg("dim", " …")]
				: lines;
		const missingRows = rows - clipped.length;
		if (missingRows <= 0) return clipped;
		const topPad = align === "center" ? Math.floor(missingRows / 2) : 0;
		const bottomPad = missingRows - topPad;
		return [...Array.from({ length: topPad }, () => ""), ...clipped, ...Array.from({ length: bottomPad }, () => "")];
	}

	#flowKeyItemText(item: { key: string; label: string }): string {
		return `${theme.fg("dim", item.key)}${theme.fg("muted", ` ${item.label}`)}`;
	}

	#flowKeyRows(width: number): string[] {
		const contentWidth = Math.max(1, width - 1);
		const separator = ` ${theme.fg("dim", "·")} `;
		const rows: string[] = [];
		let current = "";
		for (const item of FLOW_KEY_ITEMS) {
			const segment = this.#flowKeyItemText(item);
			const next = current ? `${current}${separator}${segment}` : segment;
			if (current && visibleWidth(next) > contentWidth) {
				rows.push(` ${current}`);
				current = segment;
			} else {
				current = next;
			}
		}
		if (current) rows.push(` ${current}`);
		return rows.length > 0 ? rows : [` ${theme.fg("dim", "No flow keys")}`];
	}

	#flowKeyLines(width: number, maxRows: number): string[] {
		const rows = this.#flowKeyRows(width);
		const rowLimit = Math.max(1, Math.floor(maxRows));
		if (rows.length <= rowLimit) return rows;
		if (rowLimit === 1) {
			const firstItem = FLOW_KEY_ITEMS[0];
			const firstSegment = firstItem ? this.#flowKeyItemText(firstItem) : theme.fg("dim", "keys");
			return [this.#fitToWidth(` ${firstSegment} ${theme.fg("dim", "· … ")}${theme.bold("/help")}`, width)];
		}
		return [...rows.slice(0, rowLimit - 1), ` ${theme.fg("dim", `… ${theme.bold("/help")} for more`)}`];
	}

	#flowKeyRowLimit(
		targetContentRows: number | undefined,
		changelogLineCount: number,
		lspLineCount: number,
		rightColumnWidth: number,
	): number {
		const preferredRows = this.#flowKeyRows(rightColumnWidth).length;
		if (targetContentRows === undefined) return preferredRows;

		const sessionBaselineRows = this.recentSessions.length === 0 ? 1 : Math.min(3, this.recentSessions.length);
		const availableRows =
			targetContentRows -
			WELCOME_STATIC_RIGHT_ROWS_EXCLUDING_DYNAMIC_SECTIONS -
			changelogLineCount -
			lspLineCount -
			sessionBaselineRows;
		return Math.max(1, Math.min(preferredRows, availableRows));
	}

	#whatsNewRowLimit(targetContentRows: number | undefined, lspLineCount: number, flowLineCount: number): number {
		if (targetContentRows === undefined) return 5;

		const sessionBaselineRows = this.recentSessions.length === 0 ? 1 : Math.min(3, this.recentSessions.length);
		const dynamicRows = Math.max(
			1,
			targetContentRows - WELCOME_STATIC_RIGHT_ROWS_EXCLUDING_DYNAMIC_SECTIONS - flowLineCount - lspLineCount,
		);
		const rowsAfterBaselineSessions = Math.max(1, dynamicRows - sessionBaselineRows);
		const spareRows = Math.max(0, rowsAfterBaselineSessions - DEFAULT_WHATS_NEW_ROWS);
		return Math.max(
			1,
			Math.min(MAX_WHATS_NEW_ROWS, rowsAfterBaselineSessions, DEFAULT_WHATS_NEW_ROWS + Math.floor(spareRows / 2)),
		);
	}

	#sessionTrailLimit(
		targetContentRows: number | undefined,
		changelogLineCount: number,
		lspLineCount: number,
		flowLineCount: number,
	): number {
		if (this.recentSessions.length === 0) return 0;

		const defaultLimit = Math.min(3, this.recentSessions.length);
		if (targetContentRows === undefined) return defaultLimit;

		const rowsWithDefaultTrail =
			WELCOME_STATIC_RIGHT_ROWS_EXCLUDING_DYNAMIC_SECTIONS +
			changelogLineCount +
			flowLineCount +
			lspLineCount +
			defaultLimit;
		const extraRows = Math.max(0, targetContentRows - rowsWithDefaultTrail);
		return Math.min(this.recentSessions.length, defaultLimit + extraRows);
	}

	#sessionTrailLines(rightColumnWidth: number, limit: number): string[] {
		if (this.recentSessions.length === 0) {
			return [` ${theme.fg("dim", "No saved trails")}`];
		}

		const bulletPrefix = ` ${theme.md.bullet} `;
		const prefixWidth = visibleWidth(bulletPrefix);
		const lines: string[] = [];
		for (const session of this.recentSessions.slice(0, limit)) {
			const timeSuffixRaw = ` (${session.timeAgo})`;
			const timeWidth = visibleWidth(timeSuffixRaw);
			const nameBudget = Math.max(1, rightColumnWidth - prefixWidth - timeWidth);
			const nameVis = visibleWidth(session.name);
			const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
			lines.push(`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`);
		}
		return lines;
	}

	#whatsNewLines(width: number, maxRows: number): string[] {
		const rowLimit = Math.max(1, Math.floor(maxRows));
		const changelog = this.options.changelogMarkdown?.trim();
		if (!changelog) {
			return [` ${theme.fg("dim", "Ready for your next prompt")}`];
		}

		const version = this.#latestChangelogVersion(changelog);
		if (this.options.collapseChangelog) {
			return [
				` ${theme.fg("muted", `Updated to v${version}`)}`,
				` ${theme.fg("dim", `Use ${theme.bold("/changelog")} for details`)}`,
			].slice(0, rowLimit);
		}

		const items = this.#changelogItems(changelog);
		if (items.length === 0) {
			return [
				` ${theme.fg("muted", `Updated to v${version}`)}`,
				` ${theme.fg("dim", `Use ${theme.bold("/changelog")} for details`)}`,
			].slice(0, rowLimit);
		}

		const prefix = ` ${theme.md.bullet} `;
		const textWidth = Math.max(1, width - visibleWidth(prefix));
		const visibleItemCount = items.length > rowLimit ? Math.max(1, rowLimit - 1) : rowLimit;
		const visibleItems = items.slice(0, visibleItemCount).map(item => {
			const text = visibleWidth(item) > textWidth ? truncateToWidth(item, textWidth) : item;
			return `${theme.fg("dim", prefix)}${theme.fg("muted", text)}`;
		});
		if (items.length > visibleItems.length && visibleItems.length < rowLimit) {
			visibleItems.push(` ${theme.fg("dim", `… ${theme.bold("/changelog")} for full notes`)}`);
		}
		return visibleItems;
	}

	#latestChangelogVersion(markdown: string): string {
		const versionMatch = markdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
		return versionMatch?.[1] ?? this.version;
	}

	#changelogItems(markdown: string): string[] {
		const items: string[] = [];
		let inFence = false;
		for (const rawLine of markdown.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line.startsWith("```")) {
				inFence = !inFence;
				continue;
			}
			if (inFence || !line || /^#{1,6}\s+/.test(line) || /^-{3,}$/.test(line)) {
				continue;
			}
			const withoutBullet = line
				.replace(/^[-*]\s+/, "")
				.replace(/^\d+\.\s+/, "")
				.replace(/^>\s*/, "");
			const cleaned = this.#stripMarkdown(withoutBullet);
			if (cleaned) items.push(cleaned);
		}
		return items;
	}

	#stripMarkdown(text: string): string {
		return text
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/[_~]/g, "")
			.trim();
	}

	#pill(icon: string, text: string, color: ThemeColor): string {
		return `${theme.fg("borderMuted", "[")} ${theme.fg(color, icon)} ${theme.fg("muted", text)} ${theme.fg(
			"borderMuted",
			"]",
		)}`;
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(logoLines: readonly string[]): readonly string[] {
		if (this.#animStart == null) return REST_FRAMES[this.logoMode];
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return REST_FRAMES[this.logoMode];
		// Ease-out cubic so the spin decelerates into the resting state.
		const progress = elapsed / INTRO_MS;
		const eased = 1 - (1 - progress) ** 3;
		// Sweep backward through INTRO_SWEEPS full rotations so the gradient
		// visibly spins multiple times. `eased == 1` → phase = 0 = resting frame.
		const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
		// Shine traverses the diagonal at a steady pace, decoupled from the
		// gradient phase so the two layers parallax. Strength fades out with
		// the same ease-out curve so the highlight is gone by the resting frame.
		const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
		const shineStrength = (1 - eased) ** 1.5;
		return gradientLogo(logoLines, phase, { strength: shineStrength, pos: shinePos });
	}

	#logoLines(): readonly string[] {
		if (this.logoMode === "ascii") return ASCII_CLAW_LOGO;
		if (this.logoMode === "square") return SQUARE_CLAW_LOGO;
		return RED_CLAW_LOGO;
	}
}

// biome-ignore format: preserve ASCII art layout
const RED_CLAW_LOGO = [
	"╭────────────────╮        ╭────────╮",
	"╰──────╮      ╭──╯     ╭──╯  ╭─────╯",
	"       ╰──────╯    ╭───╯  ╭──╯      ",
	"       ╭──────╮    ╰───╮  ╰──╮      ",
	"╭──────╯      ╰──╮     ╰──╮  ╰─────╮",
	"╰────────────────╯        ╰────────╯",
];

// biome-ignore format: preserve ASCII art layout
const SQUARE_CLAW_LOGO = [
	"┌────────────────┐        ┌────────┐",
	"└──────┐      ┌──┘     ┌──┘  ┌─────┘",
	"       └──────┘    ┌───┘  ┌──┘      ",
	"       ┌──────┐    └───┐  └──┐      ",
	"┌──────┘      └──┐     └──┐  └─────┐",
	"└────────────────┘        └────────┘",
];

// biome-ignore format: preserve ASCII art layout
const ASCII_CLAW_LOGO = [
	"+----------------+        +--------+",
	"+------+      +--+     +--+  +-----+",
	"       +------+    +---+  +--+      ",
	"       +------+    +---+  +--+      ",
	"+------+      +--+     +--+  +-----+",
	"+----------------+        +--------+",
];

/** Multi-stop palette for the red-claw diagonal gradient. */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[127, 29, 29], // deep shell red
	[220, 38, 38], // claw red
	[249, 115, 22], // orange coral
	[255, 138, 101], // bright coral
	[255, 215, 168], // shell highlight
];

/** 256-color ramp fallback when truecolor isn't available. */
const GRADIENT_RAMP_256 = [52, 88, 124, 160, 202, 209, 215];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}
/**
 * Apply a multi-stop diagonal gradient (bottom-left → top-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	// span+1 so `base` stays strictly < 1: avoids the wrap-around at the
	// far corner mapping back to t=0 (hot pink) on the resting frame.
	const span = Math.max(1, cols + rows - 1);
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	const colorAt = TERMINAL.trueColor
		? (t: number): string => {
				// 5-stop palette widens the visible color range and avoids the
				// deep-blue valley a naive HSL lerp falls into.
				const stops = GRADIENT_STOPS;
				const seg = t * (stops.length - 1);
				const i = Math.min(stops.length - 2, Math.floor(seg));
				const f = seg - i;
				const a = stops[i];
				const b = stops[i + 1];
				let r = a[0] + (b[0] - a[0]) * f;
				let g = a[1] + (b[1] - a[1]) * f;
				let bl = a[2] + (b[2] - a[2]) * f;
				if (shineStrength > 0) {
					const dist = Math.abs(t - shinePos);
					const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
					if (intensity > 0) {
						r += (255 - r) * intensity;
						g += (255 - g) * intensity;
						bl += (255 - bl) * intensity;
					}
				}
				return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
			}
		: (t: number): string => {
				const ramp = GRADIENT_RAMP_256;
				let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
				if (shineStrength > 0) {
					const dist = Math.abs(t - shinePos);
					const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
					// Promote to the brightest ramp slot when the shine band peaks here.
					if (intensity > 0.5) idx = ramp.length - 1;
				}
				return `\x1b[38;5;${ramp[idx]}m`;
			};
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// Diagonal: bottom-left (x=0, y=rows-1) → top-right (x=cols-1, y=0)
			const base = (x + (rows - 1 - y)) / span;
			const t = (((base + phase) % 1) + 1) % 1;
			result += colorAt(t) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/** Resting gradient frames, cached for re-renders outside of the intro. */
const REST_FRAMES: Record<WelcomeLogoMode, readonly string[]> = {
	unicode: gradientLogo(RED_CLAW_LOGO, 0),
	square: gradientLogo(SQUARE_CLAW_LOGO, 0),
	ascii: gradientLogo(ASCII_CLAW_LOGO, 0),
};
