/**
 * Renderer theme catalog mirrored from the bundled TUI themes
 * (`packages/coding-agent/src/modes/theme/defaults`). Every bundled TUI theme is a
 * dark palette, so the desktop follows the selected theme instead of the OS scheme.
 *
 * Status colors are deliberately theme-independent: the default red-claw palette
 * already uses red/orange for accents, so deriving run/wait/error colors from the
 * accent would erase the distinction between them.
 */
export const DESKTOP_THEMES = {
	"red-claw": {
		label: "Red Claw",
		bg: "#110b0b",
		sidebar: "#1b1010",
		card: "#221313",
		surface: "#2a1515",
		border: "#4a2320",
		inputBorder: "#6f4743",
		text: "#ffe7dc",
		muted: "#b98f86",
		accent: "#ff6a3d",
		onAccent: "#110b0b",
		error: "#ff4d5e",
	},
	"blue-crab": {
		label: "Blue Crab",
		bg: "#020812",
		sidebar: "#061321",
		card: "#08182a",
		surface: "#0a1d31",
		border: "#123c5f",
		inputBorder: "#55708a",
		text: "#e6f7ff",
		muted: "#9db5c9",
		accent: "#5ec8ff",
		onAccent: "#020812",
		error: "#ff5f75",
	},
	"claude-code": {
		label: "Claude Code",
		bg: "#1a1a1a",
		sidebar: "#232323",
		card: "#2a2a2a",
		surface: "#373737",
		border: "#505050",
		inputBorder: "#6e6e6e",
		text: "#ffffff",
		muted: "#a3a3a3",
		accent: "#d77757",
		onAccent: "#1a1a1a",
		error: "#ff6b80",
	},
	codex: {
		label: "Codex",
		bg: "#0f1115",
		sidebar: "#151922",
		card: "#1c2230",
		surface: "#232b3a",
		border: "#343a46",
		inputBorder: "#5f6670",
		text: "#d7d7d7",
		muted: "#8a8f98",
		accent: "#00bcd4",
		onAccent: "#0f1115",
		error: "#ef5350",
	},
	"gruvbox-dark": {
		label: "Gruvbox Dark",
		bg: "#1d2021",
		sidebar: "#282828",
		card: "#32302f",
		surface: "#3c3836",
		border: "#504945",
		inputBorder: "#7c6f64",
		text: "#ebdbb2",
		muted: "#a89984",
		accent: "#fe8019",
		onAccent: "#1d2021",
		error: "#fb4934",
	},
	opencode: {
		label: "OpenCode",
		bg: "#121212",
		sidebar: "#1c1c1c",
		card: "#252525",
		surface: "#303030",
		border: "#4b4c5c",
		inputBorder: "#6a6a6a",
		text: "#e0e0e0",
		muted: "#a0a0a0",
		accent: "#fab283",
		onAccent: "#121212",
		error: "#e06c75",
	},
	ouroboros: {
		label: "Ouroboros",
		bg: "#050b18",
		sidebar: "#0b1630",
		card: "#0d2130",
		surface: "#102b30",
		border: "#1f4646",
		inputBorder: "#5b756d",
		text: "#e7f1e9",
		muted: "#a9bbb2",
		accent: "#aee80e",
		onAccent: "#050b18",
		error: "#ff667a",
	},
} as const satisfies Record<string, DesktopThemePalette>;

export type DesktopThemeId = keyof typeof DESKTOP_THEMES;

export interface DesktopThemePalette {
	label: string;
	bg: string;
	sidebar: string;
	card: string;
	surface: string;
	border: string;
	inputBorder: string;
	text: string;
	muted: string;
	accent: string;
	onAccent: string;
	error: string;
}

export const DEFAULT_THEME_ID: DesktopThemeId = "red-claw";
export const THEME_STORAGE_KEY = "gjc.desktop.theme";
export const THEME_IDS = Object.keys(DESKTOP_THEMES) as DesktopThemeId[];

export function isThemeId(value: unknown): value is DesktopThemeId {
	return typeof value === "string" && Object.hasOwn(DESKTOP_THEMES, value);
}

/** Unknown or blocked storage falls back to the default theme without losing the session. */
export function readThemePreference(): DesktopThemeId {
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
	} catch {
		return DEFAULT_THEME_ID;
	}
}

export function writeThemePreference(id: DesktopThemeId): boolean {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, id);
		return true;
	} catch {
		return false;
	}
}

export function themeLabel(id: DesktopThemeId): string {
	return DESKTOP_THEMES[id].label;
}

const CUSTOM_PROPERTIES: Record<Exclude<keyof DesktopThemePalette, "label">, string> = {
	bg: "--bg",
	sidebar: "--sidebar",
	card: "--card",
	surface: "--surface",
	border: "--border",
	inputBorder: "--input-border",
	text: "--text",
	muted: "--muted",
	accent: "--accent",
	onAccent: "--on-accent",
	error: "--error",
};

/**
 * Writes the selected palette as custom properties on the document root. `styles.css` keeps a
 * static copy of the default palette as the pre-JS fallback, so that copy must stay in sync.
 */
export function applyTheme(id: DesktopThemeId): void {
	const palette = DESKTOP_THEMES[id];
	const root = document.documentElement;
	root.dataset.theme = id;
	for (const [key, property] of Object.entries(CUSTOM_PROPERTIES)) {
		root.style.setProperty(property, palette[key as keyof typeof CUSTOM_PROPERTIES]);
	}
}

export const FONT_SIZE_STORAGE_KEY = "gjc.desktop.font-size";
/** The root size the layout is designed for; everything else is expressed in rem. */
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 20;

export function clampFontSize(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE;
	return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

/** Unknown or blocked storage falls back to the designed size instead of failing the launch. */
export function readFontSizePreference(): number {
	try {
		const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
		return stored === null ? DEFAULT_FONT_SIZE : clampFontSize(Number(stored));
	} catch {
		return DEFAULT_FONT_SIZE;
	}
}

export function writeFontSizePreference(size: number): boolean {
	try {
		localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(clampFontSize(size)));
		return true;
	} catch {
		return false;
	}
}

/**
 * Sets the conversation text size. Every other size in `styles.css` is a rem multiple of the root,
 * and the root is the text size divided by `0.875`, so the reply text lands on the chosen pixels
 * and the rest of the surface keeps its designed proportions.
 */
export function applyFontSize(size: number): void {
	document.documentElement.style.setProperty("--text-size", `${clampFontSize(size)}px`);
}
