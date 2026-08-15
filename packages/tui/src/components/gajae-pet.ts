import * as zlib from "node:zlib";

import { encodeITerm2Multipart, wrapITerm2RecordsForTmux } from "../terminal-capabilities";
import {
	OUROBOROS_HEART_STEPS,
	OUROBOROS_IDLE_STEPS,
	OUROBOROS_PIXEL_GRIDS,
	OUROBOROS_WORK_CRY_STEPS,
	OUROBOROS_WORK_ENTER_STEPS,
	OUROBOROS_WORK_EXIT_STEPS,
	OUROBOROS_WORK_HEART_STEPS,
	OUROBOROS_WORK_STEPS,
	type OuroborosFrameName,
} from "./ouroboros-pet";

/**
 * ┌─ GAJAE PET SPRITE SPEC ────────────────────────────────────────────────┐
 * Pets are square pixel sprites drawn beside the composer. Everything here is
 * data: no PNGs or binary assets. Current pet frames are 16×16 and render into
 * the same terminal footprint.
 *
 * GRID RULES
 * - Every frame within a skin has the same square dimensions.
 * - `.` = transparent. Keep the outer columns transparent so the sprite sits
 *   snug beside the input box (the widget reserves +1 column of slack).
 *
 * PALETTE (char → role) — see PALETTE for exact RGB:
 *   .=transparent  K=dark outline  R=body red  r=red highlight
 *   V=visor screen G=visor glow(green)  H=satgat straw  h=satgat brim
 *   b=belly tan    A=antenna
 *
 * FRAME CATALOG (GajaePixelFrameName → PIXEL_GRIDS):
 *   base    idle rest; also the dance "drop/settle" beat
 *   gazeL   eyes glance left    ┐ idle loop (see gajae-pet-widget IDLE_LOOP)
 *   gazeR   eyes glance right   │
 *   flicker visor blink         ┘
 *   flex    both claws up + `^^`; dance accent + random idle flex burst
 *   danceL  left claw up + `><` + feet step left   ┐ work loop (PARA_PARA_STEPS)
 *   danceR  right claw up + `^^` + feet step right  ┘
 *
 * RENDERING: buildGajaePixelFrames({ protocol, cellWidthPx, cellHeightPx,
 * targetRows: 2 }) scales the art to 2 terminal rows and encodes each frame
 * once. Kitty uses a native `Y=` sub-cell drop (set by the widget) to sit on the
 * composer border; sixel uses transparent top padding; iTerm2 uses an inline PNG
 * sized to the reserved cell block.
 *
 * BEHAVIOR (timing, positioning, on/off) lives in
 * packages/coding-agent/src/modes/components/gajae-pet-widget.ts.
 *
 * ADD A FRAME: draw the grid → add its name to GajaePixelFrameName → register it in
 * PIXEL_GRIDS → reference it from an idle/work loop or a skin burst.
 *
 * ADD A PET (skin): append one PET_SKINS entry with its palette, frame registry,
 * base/idle/work animations and burst. The id flows into PetSkinId/PetMode
 * automatically; settings, `/pet`, and both selectors derive from PET_SKINS.
 * └────────────────────────────────────────────────────────────────────────┘
 */
type Rgb = readonly [number, number, number];

export type Palette = Record<string, Rgb | null>;
export const PET_SKIN_IDS = ["red", "blue", "ouroboros"] as const;
export type PetSkinId = (typeof PET_SKIN_IDS)[number];
/** Every pet mode: "off" plus each skin id, in menu order. */
export const PET_MODE_IDS = ["off", ...PET_SKIN_IDS] as const;
export type PetMode = (typeof PET_MODE_IDS)[number];
/** Narrow an arbitrary string to a PetMode. */
export function isPetMode(value: string): value is PetMode {
	return (PET_MODE_IDS as readonly string[]).includes(value);
}

/** Resolve a persisted mode after a skin has been removed. Explicit "off" remains off. */
export function resolvePetMode(value: string): PetMode {
	return isPetMode(value) ? value : "red";
}

const RED_PALETTE: Palette = {
	".": null, // transparent
	K: [74, 20, 8], // outline dark
	R: [229, 72, 46], // body
	r: [255, 122, 82], // body highlight
	V: [14, 22, 14], // visor screen (dark)
	G: [61, 245, 146], // visor glow green
	H: [232, 180, 90], // satgat straw
	h: [169, 117, 47], // satgat brim
	b: [216, 154, 74], // belly tan
	A: [196, 60, 30], // antenna
	w: [200, 230, 255], // tear (BlueGajae sob)
};
// BlueGajae recolors the crab to match the "blue-crab" theme (crabShell body, claw
// highlight, deep-ocean outline, azure belly, foam tears); the straw hat and green
// are shared across skins.
const BLUE_PALETTE: Palette = {
	...RED_PALETTE,
	K: [7, 38, 74], // deep ocean (outline)
	R: [47, 155, 255], // crabShell (body)
	r: [94, 200, 255], // claw (highlight)
	b: [125, 211, 252], // azure (belly)
	A: [37, 120, 200], // muted blue (antenna)
	w: [230, 247, 255], // foam (tear)
};
const OUROBOROS_PALETTE: Palette = {
	".": null,
	D: [20, 100, 48], // closed / crying eye
	R: [174, 232, 14], // vivid lime body
	r: [112, 146, 190], // cool blue underside (#7092BE)
	G: [255, 231, 134], // pale-yellow eye
	A: [255, 137, 180], // pink tongue and heart accent
	w: [190, 231, 255], // tear
};

// ------------------------------------------------------------------------
// Real-pixel frames (codex-pets style): the same grids encoded as terminal
// image escapes, for absolute-positioned overlay rendering. No PNG round
// trip — sixel and kitty raw-RGBA are generated straight from the grids.
// ------------------------------------------------------------------------

// 16x16 full-body grids used by the pixel pet -----------------------------
// biome-ignore format: pixel grid stays one row per line
const F0 = [
	"..A.........A...",
	"...A..HHHH..A...",
	"....AHHHHHHA....",
	".HHHHHHHHHHHHHH.",
	".hhhhhhhhhhhhhh.",
	"....KRRRRRRK....",
	".KK.KGGVVGGK.KK.",
	"KRRKKVVVVVVKKRRK",
	"KRrRKRRRRRRKRrRK",
	".KRRKKRbbRKKRRK.",
	".....KRbbRK.....",
	".....KRbbRK.....",
	".....KRRRRK.....",
	"....KRRRRRRK....",
	"...KRrK..KrRK...",
	"...K......K.....",
];

// Eye-only gaze frames: identical body, only visor row 6 changes.
const FL = F0.map((row, i) => (i === 6 ? ".KK.KGGVGGVK.KK." : row));
const FR = F0.map((row, i) => (i === 6 ? ".KK.KVGGVGGK.KK." : row));
// Visor flicker (blink).
const FF = F0.map((row, i) => {
	if (i === 6) return ".KK.KVVVVVVK.KK.";
	if (i === 7) return "KRRKKVGVVGVKKRRK";
	return row;
});

// Both round claws raised with a three-pixel-tall ^ ^ victory face (the dance's
// "both arms up" beat). Shares base's body and feet so the sequence stays planted.
// biome-ignore format: pixel grid stays one row per line
const FX = [
	"..A.........A...",
	"...A..HHHH..A...",
	"....AHHHHHHA....",
	".HHHHHHHHHHHHHH.",
	".hhhhhhhhhhhhhh.",
	".KK.KRRRRRRK.KK.",
	"KRRKKVGVVGVKKRRK",
	"KRrRKGVGGVGKRrRK",
	".KRRKVVVVVVKRRK.",
	"....KKRbbRKK....",
	".....KRbbRK.....",
	".....KRbbRK.....",
	".....KRRRRK.....",
	"....KRRRRRRK....",
	"...KRrK..KrRK...",
	"...K......K.....",
];

// Para-para dance: pump the round claws up one at a time (left then right) while
// stepping the feet the opposite way, with cute faces (danceL ">< ", danceR "^ ^"),
// so the arms bob AND the legs shuffle side to side while working.
const DL = F0.map((row, i) => {
	if (i === 5) return ".KK.KRRRRRRK....";
	if (i === 6) return "KRRKKGVVVGVK.KK.";
	if (i === 7) return "KRrRKVGVGVVKKRRK";
	if (i === 8) return ".KRRKGVVVGVKRrRK";
	if (i === 9) return "....KKRbbRKKRRK.";
	if (i === 13) return "...KRRRRRRK.....";
	if (i === 14) return "..KRrK..KrRK....";
	if (i === 15) return "..K......K......";
	return row;
});
const DR = F0.map((row, i) => {
	if (i === 5) return "....KRRRRRRK.KK.";
	if (i === 6) return ".KK.KVGVVGVKKRRK";
	if (i === 7) return "KRRKKGVGGVGKRrRK";
	if (i === 8) return "KRrRKVVVVVVKRRK.";
	if (i === 9) return ".KRRKKRbbRKK....";
	if (i === 13) return ".....KRRRRRRK...";
	if (i === 14) return "....KRrK..KrRK..";
	if (i === 15) return "....K......K....";
	return row;
});

// BlueGajae's idle sob: a squeezed `>< ` visor (arms down, unlike RedGajae's flex)
// with a light tear that falls diagonally outward across the three frames.
const CRY_FACE: Record<number, string> = {
	6: ".KK.KGVVVGVK.KK.",
	7: "KRRKKVGVGVVKKRRK",
	8: "KRrRKGVVVGVKRrRK",
};
const CR1 = F0.map((row, i) => CRY_FACE[i] ?? (i === 10 ? "....wKRbbRKw...." : row));
const CR2 = F0.map((row, i) => CRY_FACE[i] ?? (i === 11 ? "...w.KRbbRK.w..." : row));
const CR3 = F0.map((row, i) => CRY_FACE[i] ?? (i === 12 ? "..w..KRRRRK..w.." : row));

/** Logical pixel-pet frame names shared by the overlay state machine. */
export type GajaePixelFrameName =
	| "base"
	| "gazeL"
	| "gazeR"
	| "flicker"
	| "flex"
	| "danceL"
	| "danceR"
	| "cry1"
	| "cry2"
	| "cry3";
export type PetFrameName = GajaePixelFrameName | OuroborosFrameName;

const PIXEL_GRIDS: Record<GajaePixelFrameName, string[]> = {
	base: F0,
	gazeL: FL,
	gazeR: FR,
	flicker: FF,
	flex: FX,
	danceL: DL,
	danceR: DR,
	cry1: CR1,
	cry2: CR2,
	cry3: CR3,
};

/** Para-para work dance beats: the working loop and each skin's burst "work-in" intro. */
export type GajaeGifFrameTuple = readonly [GajaePixelFrameName, number];
export const PARA_PARA_STEPS: readonly GajaeGifFrameTuple[] = [
	["danceL", 300],
	["danceR", 300],
	["base", 260],
	["flex", 480],
	["base", 260],
];
export const GAJAE_IDLE_STEPS: ReadonlyArray<readonly [GajaePixelFrameName, number]> = [
	["base", 1100],
	["gazeL", 350],
	["base", 500],
	["gazeR", 350],
	["base", 800],
	["flicker", 150],
];

/**
 * A skin's idle burst: a short intro sequence, then an optional looping tail. It drives
 * BOTH the random live show-off AND the selector's preview demo, so give every skin a
 * real animation (reuse PARA_PARA_STEPS for a work-in intro) rather than one held frame.
 */
export interface PetBurst {
	/** Frames played once, in order, at the start of the burst. */
	intro: ReadonlyArray<readonly [PetFrameName, number]>;
	/** Frames cycled every `stepMs` for `ms` after the intro (a held or looping finish). */
	tail?: { frames: readonly PetFrameName[]; stepMs: number; ms: number };
}

/** Everything that defines a pet skin: identity, UI copy, colors and behavior. */
export interface PetSkin {
	id: PetSkinId;
	/** Selector/settings label, e.g. "RedGajae". */
	label: string;
	/** One-line selector/settings description. */
	description: string;
	palette: Palette;
	frames: Readonly<Record<string, string[]>>;
	baseFrame: PetFrameName;
	idle: ReadonlyArray<readonly [PetFrameName, number]>;
	workEnter?: ReadonlyArray<readonly [PetFrameName, number]>;
	work: ReadonlyArray<readonly [PetFrameName, number]>;
	workExit?: ReadonlyArray<readonly [PetFrameName, number]>;
	/** Idle burst animation played between quiet idle loops. */
	burst: PetBurst;
	/** Optional variants that interrupt and then resume the work loop. */
	workBursts?: readonly PetBurst[];
}

/** Skin registry — the single source for palettes, behavior and selector/command copy. */
export const PET_SKINS: Record<PetSkinId, PetSkin> = {
	red: {
		id: "red",
		label: "RedGajae",
		description: "The Red Crab, who likes to work-out.",
		palette: RED_PALETTE,
		frames: PIXEL_GRIDS,
		baseFrame: "base",
		idle: GAJAE_IDLE_STEPS,
		work: PARA_PARA_STEPS,
		burst: {
			intro: PARA_PARA_STEPS,
			tail: { frames: ["flex", "base"], stepMs: 200, ms: 1000 },
		},
	},
	blue: {
		id: "blue",
		label: "BlueGajae",
		description: "The Blue Crab, who wants to rest.",
		palette: BLUE_PALETTE,
		frames: PIXEL_GRIDS,
		baseFrame: "base",
		idle: GAJAE_IDLE_STEPS,
		work: PARA_PARA_STEPS,
		burst: {
			intro: PARA_PARA_STEPS,
			tail: { frames: ["cry1", "cry2", "cry3"], stepMs: 110, ms: 990 },
		},
	},
	ouroboros: {
		id: "ouroboros",
		label: "Ouroboros",
		description: "The little snake who keeps going.",
		palette: OUROBOROS_PALETTE,
		frames: OUROBOROS_PIXEL_GRIDS,
		baseFrame: "idle",
		idle: OUROBOROS_IDLE_STEPS,
		workEnter: OUROBOROS_WORK_ENTER_STEPS,
		work: OUROBOROS_WORK_STEPS,
		workExit: OUROBOROS_WORK_EXIT_STEPS,
		burst: {
			intro: OUROBOROS_HEART_STEPS,
		},
		workBursts: [{ intro: OUROBOROS_WORK_HEART_STEPS }, { intro: OUROBOROS_WORK_CRY_STEPS }],
	},
};

/** Total burst duration (intro beats plus the looping tail). */
export function petBurstDurationMs(burst: PetBurst): number {
	const introMs = burst.intro.reduce((sum, [, delayMs]) => sum + delayMs, 0);
	return introMs + (burst.tail?.ms ?? 0);
}

/** The frame to show `elapsed` ms into a burst (`now` cycles the looping tail). */
export function petBurstFrame(burst: PetBurst, elapsed: number, now: number): PetFrameName {
	let t = elapsed;
	for (const [name, delayMs] of burst.intro) {
		if (t < delayMs) return name;
		t -= delayMs;
	}
	const tail = burst.tail;
	if (!tail || tail.frames.length === 0) return burst.intro[burst.intro.length - 1]?.[0] ?? "base";
	return tail.frames[Math.floor(now / tail.stepMs) % tail.frames.length];
}

/** Test-only access to logical art; production rendering still uses encoded frames. */
export const __gajaePetTestHooks = {
	getPixelGrid(name: PetFrameName, skin: PetSkinId = "red"): string[] {
		const grid = PET_SKINS[skin].frames[name];
		if (!grid) throw new Error(`Unknown ${skin} pet frame: ${name}`);
		return [...grid];
	},
};

export interface GajaeGifFrame {
	readonly name: PetFrameName;
	readonly delayMs: number;
}
export type GajaeGifTimeline = readonly GajaeGifFrame[];
export interface GajaeGifRectangle {
	readonly width?: number;
	readonly height?: number;
}
export interface GajaeGifDisplaySize {
	/** iTerm2 display width: bare numbers are terminal cells; strings may use px or auto. */
	readonly width: number | string;
	/** iTerm2 display height: bare numbers are terminal cells; strings may use px or auto. */
	readonly height: number | string;
}
export interface GajaeGifContentInset {
	/** Transparent top padding in source pixels. */
	readonly topPx?: number;
	/** Transparent bottom padding in source pixels. */
	readonly bottomPx?: number;
}
export interface GajaePetGifArtifact {
	readonly bytes: Uint8Array;
	readonly base64: string;
	readonly width: number;
	readonly height: number;
	readonly frames: readonly GajaeGifFrame[];
	readonly skin: PetSkinId;
	readonly multipart: readonly string[];
	readonly tmuxDcs: readonly string[];
}
export interface GajaePetGifOptions {
	readonly skin?: PetSkinId;
	readonly timeline?: GajaeGifTimeline;
	readonly cellWidthPx?: number;
	readonly cellHeightPx?: number;
	readonly targetRows?: number;
	readonly rectangle?: GajaeGifRectangle;
	readonly displaySize?: GajaeGifDisplaySize;
	readonly contentInset?: GajaeGifContentInset;
}
const GIF_CLEAR = 256,
	GIF_END = 257;
function gifLzw(pixels: number[], minCodeSize = 8): Uint8Array {
	const out: number[] = [],
		codes = pixels.flatMap(p => [GIF_CLEAR, p]).concat(GIF_END);
	let bits = 0,
		value = 0;
	for (const code of codes) {
		value |= code << bits;
		bits += minCodeSize + 1;
		while (bits >= 8) {
			out.push(value & 255);
			value >>>= 8;
			bits -= 8;
		}
	}
	if (bits) out.push(value & 255);
	const blocks: number[] = [minCodeSize];
	for (let i = 0; i < out.length; i += 255) {
		const part = out.slice(i, i + 255);
		blocks.push(part.length, ...part);
	}
	blocks.push(0);
	return Uint8Array.from(blocks);
}
export const idleTimeline = (): GajaeGifTimeline => [
	{ name: "base", delayMs: 700 },
	{ name: "gazeL", delayMs: 180 },
	{ name: "base", delayMs: 700 },
	{ name: "gazeR", delayMs: 180 },
	{ name: "flicker", delayMs: 120 },
];
export const workingTimeline = (): GajaeGifTimeline => PARA_PARA_STEPS.map(([name, delayMs]) => ({ name, delayMs }));
export const burstTimeline = (skin: PetSkinId = "red"): GajaeGifTimeline => {
	const burst = PET_SKINS[skin].burst;
	const frames: GajaeGifFrame[] = burst.intro.map(([name, delayMs]) => ({ name, delayMs }));
	const tail = burst.tail;
	if (!tail || tail.frames.length === 0) return frames;
	for (let elapsed = 0; elapsed < tail.ms; elapsed += tail.stepMs) {
		frames.push({
			name: tail.frames[Math.floor(elapsed / tail.stepMs) % tail.frames.length],
			delayMs: Math.min(tail.stepMs, tail.ms - elapsed),
		});
	}
	return frames;
};
export const previewTimeline = (skin: PetSkinId = "red"): GajaeGifTimeline => burstTimeline(skin);
function isGifTimeline(input: GajaePetGifOptions | GajaeGifTimeline): input is GajaeGifTimeline {
	return Array.isArray(input);
}
function gifOptions(input: GajaePetGifOptions | GajaeGifTimeline): Required<
	Pick<GajaePetGifOptions, "skin" | "timeline" | "cellWidthPx" | "cellHeightPx" | "targetRows">
> & {
	rectangle?: GajaeGifRectangle;
	displaySize?: GajaeGifDisplaySize;
	contentInset?: GajaeGifContentInset;
} {
	if (isGifTimeline(input)) {
		return { skin: "red", timeline: input, cellWidthPx: 1, cellHeightPx: 1, targetRows: 16 };
	}
	return {
		skin: input.skin ?? "red",
		timeline: input.timeline ?? idleTimeline(),
		cellWidthPx: input.cellWidthPx ?? 1,
		cellHeightPx: input.cellHeightPx ?? 1,
		targetRows: input.targetRows ?? 16,
		rectangle: input.rectangle,
		displaySize: input.displaySize,
		contentInset: input.contentInset,
	};
}
export function encodeGajaePetGif(input: GajaePetGifOptions | GajaeGifTimeline = {}): GajaePetGifArtifact {
	const o = gifOptions(input),
		rect = o.rectangle ?? {};
	if (o.timeline.length === 0) throw new Error("GIF timeline must not be empty");
	for (const frame of o.timeline) {
		if (!Number.isFinite(frame.delayMs) || frame.delayMs < 0) throw new Error("Invalid GIF frame delay");
	}
	const width = rect.width ?? rect.height ?? Math.round(Math.max(1, o.targetRows * o.cellHeightPx));
	const height = rect.height ?? Math.round(Math.max(1, o.targetRows * o.cellHeightPx));
	const valid = (n: number, label: string): number => {
		if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 0xffff) throw new Error(`Invalid GIF ${label}`);
		return n;
	};
	valid(width, "width");
	valid(height, "height");
	const inset = o.contentInset ?? {};
	const topInset = inset.topPx ?? 0;
	const bottomInset = inset.bottomPx ?? 0;
	if (
		![topInset, bottomInset].every(value => Number.isFinite(value) && Number.isInteger(value) && value >= 0) ||
		topInset + bottomInset >= height
	)
		throw new Error("Invalid GIF content inset");
	const contentHeight = height - topInset - bottomInset;
	if (width * height * o.timeline.length > 64 * 1024 * 1024) throw new Error("GIF allocation exceeds safety budget");
	const paletteKeys = Object.keys(PET_SKINS[o.skin].palette).filter(k => k !== ".");
	const palette = [[0, 0, 0], ...paletteKeys.map(k => PET_SKINS[o.skin].palette[k]!)];
	const chunks: number[] = [
		...Buffer.from("GIF89a"),
		width & 255,
		width >> 8,
		height & 255,
		height >> 8,
		0xf7,
		0,
		0,
		...palette.flat(),
		...Array((256 - palette.length) * 3).fill(0),
		33,
		255,
		11,
		...Buffer.from("NETSCAPE2.0"),
		3,
		1,
		0,
		0,
		0,
	];
	for (const frame of o.timeline) {
		const pixels: number[] = [],
			grid = PET_SKINS[o.skin].frames[frame.name];
		if (!grid) throw new Error(`Unknown ${o.skin} GIF frame: ${frame.name}`);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const contentY = y - topInset;
				if (contentY < 0 || contentY >= contentHeight) {
					pixels.push(0);
					continue;
				}
				const sx = Math.min(15, Math.floor((x * 16) / width));
				const sy = Math.min(15, Math.floor((contentY * 16) / contentHeight));
				const ch = grid[sy][sx];
				pixels.push(ch === "." ? 0 : Math.max(1, paletteKeys.indexOf(ch) + 1));
			}
		const delay = Math.round(frame.delayMs / 10);
		chunks.push(
			33,
			249,
			4,
			0x09,
			delay & 255,
			delay >> 8,
			0,
			0,
			44,
			0,
			0,
			0,
			0,
			width & 255,
			width >> 8,
			height & 255,
			height >> 8,
			0,
			...gifLzw(pixels),
		);
	}
	chunks.push(59);
	const bytes = Uint8Array.from(chunks);
	const base64 = Buffer.from(bytes).toString("base64");
	const multipart = encodeITerm2Multipart(base64, {
		width: o.displaySize?.width ?? `${width}px`,
		height: o.displaySize?.height ?? `${height}px`,
	});
	const tmuxDcs = wrapITerm2RecordsForTmux(multipart);
	return {
		bytes,
		base64,
		width,
		height,
		frames: [...o.timeline],
		skin: o.skin,
		multipart,
		tmuxDcs,
	};
}
const gifCache = new Map<string, GajaePetGifArtifact>();
let gifCacheBytes = 0;
let gifCacheBase64Bytes = 0;
let gifCacheMultipartBytes = 0;
let gifCacheTmuxDcsBytes = 0;
let gifCacheEvictions = 0;
const GIF_CACHE_MAX_ENTRIES = 32;
const GIF_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export function getGajaePetGifCached(input: GajaePetGifOptions | GajaeGifTimeline = {}): GajaePetGifArtifact {
	const o = gifOptions(input),
		key = JSON.stringify([
			o.skin,
			o.timeline,
			o.cellWidthPx,
			o.cellHeightPx,
			o.targetRows,
			o.rectangle,
			o.displaySize,
			o.contentInset,
		]),
		hit = gifCache.get(key);
	if (hit) {
		gifCache.delete(key);
		gifCache.set(key, hit);
		return hit;
	}
	const value = encodeGajaePetGif(o);
	gifCache.set(key, value);
	gifCacheBytes += value.bytes.byteLength;
	gifCacheBase64Bytes += byteLength(value.base64);
	gifCacheMultipartBytes += value.multipart.reduce((sum, record) => sum + byteLength(record), 0);
	gifCacheTmuxDcsBytes += value.tmuxDcs.reduce((sum, record) => sum + byteLength(record), 0);
	while (
		gifCache.size > GIF_CACHE_MAX_ENTRIES ||
		gifCacheBytes + gifCacheBase64Bytes + gifCacheMultipartBytes + gifCacheTmuxDcsBytes > GIF_CACHE_MAX_BYTES
	) {
		const k = gifCache.keys().next().value as string,
			old = gifCache.get(k)!;
		gifCache.delete(k);
		gifCacheBytes -= old.bytes.byteLength;
		gifCacheBase64Bytes -= byteLength(old.base64);
		gifCacheMultipartBytes -= old.multipart.reduce((sum, record) => sum + byteLength(record), 0);
		gifCacheTmuxDcsBytes -= old.tmuxDcs.reduce((sum, record) => sum + byteLength(record), 0);
		gifCacheEvictions++;
	}
	return value;
}
export function getGajaePetGifCacheStats(): {
	size: number;
	bytes: number;
	gifBytes: number;
	base64Bytes: number;
	multipartBytes: number;
	tmuxDcsBytes: number;
	evictions: number;
} {
	return {
		size: gifCache.size,
		bytes: gifCacheBytes + gifCacheBase64Bytes + gifCacheMultipartBytes + gifCacheTmuxDcsBytes,
		gifBytes: gifCacheBytes,
		base64Bytes: gifCacheBase64Bytes,
		multipartBytes: gifCacheMultipartBytes,
		tmuxDcsBytes: gifCacheTmuxDcsBytes,
		evictions: gifCacheEvictions,
	};
}
export function resetGajaePetGifCache(): void {
	gifCache.clear();
	gifCacheBytes = 0;
	gifCacheBase64Bytes = 0;
	gifCacheMultipartBytes = 0;
	gifCacheTmuxDcsBytes = 0;
	gifCacheEvictions = 0;
}
export const clearGajaePetGifCache = resetGajaePetGifCache;
/** Encode a grid as a transparent SIXEL image, optionally bottom-aligned by top padding. */
export function encodeGridSixel(
	grid: string[],
	scale: number,
	topPaddingPx = 0,
	palette: Palette = RED_PALETTE,
): string {
	const gw = grid[0].length;
	const gh = grid.length;
	const w = Math.round(gw * scale);
	const h = Math.round(gh * scale) + topPaddingPx;
	const colors: Rgb[] = [];
	const colorIndex = new Map<string, number>();
	// pixel color index per row/col, -1 = transparent
	const px: number[][] = [];
	for (let y = 0; y < h; y++) {
		const row: number[] = [];
		for (let x = 0; x < w; x++) {
			const sourceY = y - topPaddingPx;
			const ch =
				sourceY < 0
					? "."
					: grid[Math.min(gh - 1, Math.floor(sourceY / scale))][Math.min(gw - 1, Math.floor(x / scale))];
			const rgb = palette[ch];
			if (!rgb) {
				row.push(-1);
				continue;
			}
			const key = rgb.join(",");
			let idx = colorIndex.get(key);
			if (idx === undefined) {
				idx = colors.length;
				colors.push(rgb);
				colorIndex.set(key, idx);
			}
			row.push(idx);
		}
		px.push(row);
	}

	// DCS is P1;P2;P3: transparency is the second parameter (P2=1).
	let out = `\x1bP0;1;0q"1;1;${w};${h}`;
	for (let i = 0; i < colors.length; i++) {
		const [r, g, b] = colors[i];
		out += `#${i};2;${Math.round((r / 255) * 100)};${Math.round((g / 255) * 100)};${Math.round((b / 255) * 100)}`;
	}
	for (let bandTop = 0; bandTop < h; bandTop += 6) {
		for (let c = 0; c < colors.length; c++) {
			let line = "";
			let used = false;
			for (let x = 0; x < w; x++) {
				let bits = 0;
				for (let dy = 0; dy < 6 && bandTop + dy < h; dy++) {
					if (px[bandTop + dy][x] === c) bits |= 1 << dy;
				}
				if (bits) used = true;
				line += String.fromCharCode(63 + bits);
			}
			if (used) out += `#${c}${line}$`;
		}
		out += "-";
	}
	return `${out}\x1b\\`;
}

const MAX_PET_PNG_DIMENSION = 16_384;
const MAX_PET_PNG_RAW_BYTES = 64 * 1024 * 1024;
const MAX_PET_FRAME_DIMENSION = 4_096;
const MAX_PET_FRAME_RGBA_BYTES = 16 * 1024 * 1024;

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = Buffer.from(type, "ascii");
	const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
	let crc = 0xffffffff;
	for (const byte of payload) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	crc = (crc ^ 0xffffffff) >>> 0;
	const out = Buffer.allocUnsafe(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	Buffer.from(payload).copy(out, 4);
	out.writeUInt32BE(crc, 8 + data.length);
	return out;
}

function validatePngGrid(
	grid: string[],
	scale: number,
	topPaddingPx: number,
	bottomPaddingPx: number,
	leftPaddingPx: number,
	rightPaddingPx: number,
): {
	gridWidth: number;
	gridHeight: number;
	spriteWidth: number;
	width: number;
	spriteHeight: number;
	height: number;
} {
	const gridHeight = grid.length;
	const gridWidth = grid[0]?.length ?? 0;
	if (gridHeight === 0 || gridWidth === 0 || grid.some(row => row.length !== gridWidth)) {
		throw new Error("iTerm2 pet grid must be non-empty and rectangular");
	}
	if (!Number.isFinite(scale) || scale <= 0) throw new Error("iTerm2 pet scale must be finite and positive");
	for (const [name, value] of [
		["top padding", topPaddingPx],
		["bottom padding", bottomPaddingPx],
		["left padding", leftPaddingPx],
		["right padding", rightPaddingPx],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error(`iTerm2 pet ${name} must be a non-negative integer`);
	}
	const spriteWidth = Math.round(gridWidth * scale);
	const spriteHeight = Math.round(gridHeight * scale);
	const width = spriteWidth + leftPaddingPx + rightPaddingPx;
	const height = spriteHeight + topPaddingPx + bottomPaddingPx;
	if (
		!Number.isSafeInteger(spriteWidth) ||
		!Number.isSafeInteger(spriteHeight) ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		spriteWidth <= 0 ||
		spriteHeight <= 0 ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_PET_PNG_DIMENSION ||
		height > MAX_PET_PNG_DIMENSION
	) {
		throw new Error("iTerm2 pet PNG dimensions are out of bounds");
	}
	const stride = width * 4 + 1;
	const rawBytes = stride * height;
	if (!Number.isSafeInteger(rawBytes) || rawBytes > MAX_PET_PNG_RAW_BYTES) {
		throw new Error("iTerm2 pet PNG allocation is out of bounds");
	}
	return { gridWidth, gridHeight, spriteWidth, spriteHeight, width, height };
}

/**
 * Encode a grid as an iTerm2 inline PNG spanning a terminal cell block.
 *
 * The escape's `width`/`height` are the reserved cell-block footprint in
 * character cells (unitless numbers per the iTerm2 inline-images protocol).
 * iTerm2 resolves cells against its own live font metrics, so the sprite
 * scales with the real terminal geometry — including Retina, where iTerm2
 * divides `Npx` values by the backing-scale factor and would render a fixed
 * pixel box at half size.
 */
export function encodeGridIterm2(
	grid: string[],
	scale: number,
	columns: number,
	rows: number,
	topPaddingPx = 0,
	bottomPaddingPx = 0,
	leftPaddingPx = 0,
	rightPaddingPx = 0,
	palette: Palette = RED_PALETTE,
): string {
	for (const [name, value] of [
		["column count", columns],
		["row count", rows],
	] as const) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`iTerm2 pet ${name} must be a positive integer`);
		}
	}
	const { gridWidth, gridHeight, spriteWidth, spriteHeight, width, height } = validatePngGrid(
		grid,
		scale,
		topPaddingPx,
		bottomPaddingPx,
		leftPaddingPx,
		rightPaddingPx,
	);
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sourceX = x - leftPaddingPx;
			const sourceY = y - topPaddingPx;
			const rgb =
				sourceX < 0 || sourceX >= spriteWidth || sourceY < 0 || sourceY >= spriteHeight
					? null
					: palette[
							grid[Math.min(gridHeight - 1, Math.floor(sourceY / scale))][
								Math.min(gridWidth - 1, Math.floor(sourceX / scale))
							]
						];
			const offset = y * (width * 4 + 1) + 1 + x * 4;
			if (!rgb) continue;
			raw[offset] = rgb[0];
			raw[offset + 1] = rgb[1];
			raw[offset + 2] = rgb[2];
			raw[offset + 3] = 255;
		}
	}
	const compressed = zlib.deflateSync(raw);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const png = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", compressed),
		pngChunk("IEND", new Uint8Array()),
	]);
	// Size in character cells, not pixels: iTerm2 applies its own cell metrics
	// (and divides px values by the Retina backing scale), so cells keep the
	// padded canvas 1:1 with the reserved block at every geometry.
	// iTerm uses the supplied filename when a user drags this inline image out.
	// The unique name lets the composer discard only this pet's automatic path paste.
	const params = `name=Z2FqYWUtcGV0LnBuZw==;width=${columns};height=${rows};preserveAspectRatio=0;inline=1`;
	return `\x1b]1337;File=${params}:${png.toString("base64")}\x1b\\`;
}

/** Encode a bottom-aligned grid as kitty raw RGBA at `scale`. */
export function encodeGridKitty(
	grid: string[],
	scale: number,
	imageId: number,
	cols: number,
	rows: number,
	topPaddingPx = 0,
	cellYOffsetPx = 0,
	leftPaddingPx = 0,
	rightPaddingPx = 0,
	palette: Palette = RED_PALETTE,
): string {
	const gw = grid[0].length;
	const gh = grid.length;
	const spriteW = Math.round(gw * scale);
	// Pad the canvas to the full cell block (cols*cellWidth) so the square sprite
	// renders 1:1 within it.
	const w = spriteW + leftPaddingPx + rightPaddingPx;
	const h = Math.round(gh * scale) + topPaddingPx;
	const rgba = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const sourceX = x - leftPaddingPx;
			const sourceY = y - topPaddingPx;
			const rgb =
				sourceX < 0 || sourceX >= spriteW || sourceY < 0
					? null
					: palette[
							grid[Math.min(gh - 1, Math.floor(sourceY / scale))][Math.min(gw - 1, Math.floor(sourceX / scale))]
						];
			if (!rgb) continue;
			const o = (y * w + x) * 4;
			rgba[o] = rgb[0];
			rgba[o + 1] = rgb[1];
			rgba[o + 2] = rgb[2];
			rgba[o + 3] = 255;
		}
	}
	const data = Buffer.from(rgba).toString("base64");
	const CHUNK = 4000;
	// `Y=` offsets the sprite down by sub-cell pixels within the first cell — the
	// kitty analogue of the sixel top-padding drop. `C=1` keeps the placement
	// cursor-neutral so the overlay never nudges the composer's real cursor.
	const yParam = cellYOffsetPx > 0 ? `,Y=${Math.round(cellYOffsetPx)}` : "";
	let out = `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
	for (let off = 0, first = true; off < data.length; off += CHUNK, first = false) {
		const chunk = data.slice(off, off + CHUNK);
		const more = off + CHUNK < data.length ? 1 : 0;
		out += first
			? `\x1b_Ga=T,f=32,s=${w},v=${h},c=${cols},r=${rows},i=${imageId},q=2,C=1${yParam},m=${more};${chunk}\x1b\\`
			: `\x1b_Gm=${more};${chunk}\x1b\\`;
	}
	return out;
}

export interface GajaePixelFrames {
	/** escape payload per logical frame (drawn at the current cursor cell) */
	frames: Record<string, string>;
	/** protocol the frames were encoded for */
	protocol: "sixel" | "kitty" | "iterm2";
	/** Scaled sprite width before transparent cell-block padding. */
	widthPx: number;
	/** Encoded raster height, including protocol-specific transparent padding. */
	heightPx: number;
	columns: number;
	rows: number;
	/** terminal rows touched by the encoded raster, including pixel offset */
	rasterRows: number;
}

/**
 * Build overlay pixel frames exactly `targetRows` terminal rows tall when the
 * terminal cells permit it. Each skin owns its source resolution so future
 * additions can opt into denser art without changing the terminal footprint.
 *
 * Geometry contract:
 * - `scale = max(1, targetRows * cellHeightPx / gridHeight)`
 * - `columns = ceil(scaledSpriteWidthPx / cellWidthPx)`
 * - `rows = ceil(scaledSpriteHeightPx / cellHeightPx)`
 * - the square sprite is centered in a `columns * cellWidthPx` PNG canvas
 *
 * iTerm2 receives unitless `width=columns;height=rasterRows`, so it resolves the
 * padded block with its live cell metrics. The PNG has that block's pixel aspect
 * ratio, allowing `preserveAspectRatio=0` without stretching the authored square
 * sprite. Kitty and Sixel retain their protocol-specific paths.
 */
export function buildGajaePixelFrames(options: {
	protocol: "sixel" | "kitty" | "iterm2";
	cellWidthPx: number;
	cellHeightPx: number;
	targetRows?: number;
	/** Transparent pixel offset above sixel art for sub-cell vertical placement. */
	sixelTopPaddingPx?: number;
	/** Native sub-cell `Y=` pixel offset that drops the kitty sprite within its first cell. */
	kittyCellYOffsetPx?: number;
	kittyImageId?: number;
	/** Additional transparent iTerm2-only top padding for sub-cell vertical alignment. */
	iterm2TopPaddingPx?: number;
	/** Transparent iTerm2-only bottom padding inside the canvas. */
	iterm2BottomPaddingPx?: number;
	/** Color skin for the sprite palette (default "red"). */
	skin?: PetSkinId;
}): GajaePixelFrames {
	const targetRows = options.targetRows ?? 2;
	if (!Number.isFinite(options.cellWidthPx) || options.cellWidthPx <= 0) {
		throw new Error("Pet cell width must be finite and positive");
	}
	if (!Number.isFinite(options.cellHeightPx) || options.cellHeightPx <= 0) {
		throw new Error("Pet cell height must be finite and positive");
	}
	if (!Number.isFinite(targetRows) || targetRows <= 0) throw new Error("Pet target rows must be finite and positive");
	const skin = PET_SKINS[options.skin ?? "red"];
	const grids = Object.entries(skin.frames);
	const firstGrid = grids[0]?.[1];
	if (!firstGrid?.[0]) throw new Error(`Pet skin ${skin.id} has no pixel frames`);
	const gridHeight = firstGrid.length;
	const gridWidth = firstGrid[0].length;
	for (const [name, grid] of grids) {
		if (grid.length !== gridHeight || grid.some(row => row.length !== gridWidth)) {
			throw new Error(`Pet frame ${skin.id}/${name} does not match ${gridWidth}x${gridHeight}`);
		}
	}
	const scale = Math.max(1, (targetRows * options.cellHeightPx) / gridHeight);
	const widthPx = Math.round(gridWidth * scale);
	const visibleHeightPx = Math.round(gridHeight * scale);
	const columns = Math.ceil(widthPx / options.cellWidthPx);
	const rows = Math.ceil(visibleHeightPx / options.cellHeightPx);
	const allocatedHeightPx = rows * options.cellHeightPx;
	const topPaddingPx =
		allocatedHeightPx - visibleHeightPx + (options.protocol === "sixel" ? (options.sixelTopPaddingPx ?? 0) : 0);
	const heightPx = visibleHeightPx + topPaddingPx;
	const kittyYOffsetPx = options.protocol === "kitty" ? Math.max(0, Math.round(options.kittyCellYOffsetPx ?? 0)) : 0;
	// Center the square sprite in its (cols * cellWidth) block, which the ceil()
	// column rounding can make wider than the sprite itself.
	const horizontalPaddingPx = Math.max(0, columns * options.cellWidthPx - widthPx);
	const leftPaddingPx = Math.floor(horizontalPaddingPx / 2);
	const rightPaddingPx = horizontalPaddingPx - leftPaddingPx;
	const canvasWidthPx = widthPx + leftPaddingPx + rightPaddingPx;
	// When minimum 1x art is taller than targetRows (only possible with tiny
	// cells), top-pad iTerm2 to the full reserved row block. Its unitless OSC
	// height then maps the PNG 1:1 without vertically stretching the authored square sprite.
	const iterm2TopPaddingPx =
		allocatedHeightPx - visibleHeightPx + (options.protocol === "iterm2" ? (options.iterm2TopPaddingPx ?? 0) : 0);
	const protocolHeightPx =
		options.protocol === "iterm2"
			? visibleHeightPx + iterm2TopPaddingPx + (options.iterm2BottomPaddingPx ?? 0)
			: heightPx;
	const rasterRows = Math.ceil((protocolHeightPx + kittyYOffsetPx) / options.cellHeightPx);
	if (
		widthPx > MAX_PET_FRAME_DIMENSION ||
		heightPx > MAX_PET_FRAME_DIMENSION ||
		canvasWidthPx > MAX_PET_FRAME_DIMENSION ||
		!Number.isSafeInteger(canvasWidthPx * heightPx * 4) ||
		canvasWidthPx * heightPx * 4 > MAX_PET_FRAME_RGBA_BYTES
	) {
		throw new Error("Pet frame dimensions are out of bounds");
	}
	const imageId = options.kittyImageId ?? 0xc0de;
	const frames: Record<string, string> = {};
	for (const [name, grid] of grids) {
		frames[name] =
			options.protocol === "sixel"
				? encodeGridSixel(grid, scale, topPaddingPx, skin.palette)
				: options.protocol === "iterm2"
					? encodeGridIterm2(
							grid,
							scale,
							columns,
							rasterRows,
							iterm2TopPaddingPx,
							options.iterm2BottomPaddingPx ?? 0,
							leftPaddingPx,
							rightPaddingPx,
							skin.palette,
						)
					: encodeGridKitty(
							grid,
							scale,
							imageId,
							columns,
							rows,
							topPaddingPx,
							options.kittyCellYOffsetPx ?? 0,
							leftPaddingPx,
							rightPaddingPx,
							skin.palette,
						);
	}

	return {
		frames,
		protocol: options.protocol,
		widthPx,
		heightPx: protocolHeightPx,
		columns,
		rows,
		rasterRows,
	};
}
