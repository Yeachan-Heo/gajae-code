/**
 * ┌─ GAJAE PET SPRITE SPEC ────────────────────────────────────────────────┐
 * The pet is a 16×16 pixel sprite drawn beside the composer. Everything here is
 * data: no PNGs, no assets — each frame is 16 strings of 16 chars, encoded to a
 * sixel or kitty escape at runtime. Author a new frame by drawing a grid.
 *
 * GRID RULES
 * - Exactly 16 rows × 16 columns. Only PALETTE keys below are valid chars.
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
 * composer border; sixel uses transparent top padding.
 *
 * BEHAVIOR (timing, positioning, on/off) lives in
 * packages/coding-agent/src/modes/components/gajae-pet-widget.ts.
 *
 * ADD A FRAME: draw the grid → add its name to GajaePixelFrameName → register it in
 * PIXEL_GRIDS → reference it from an idle/work loop or a skin burst.
 *
 * ADD A PET (skin): append one entry to PET_SKINS below — { id, label, description,
 * palette, burst }. The id flows into PetSkinId/PetMode automatically, the settings
 * enum, `/pet` command and both selectors derive their options from PET_SKINS, and the
 * widget reads `burst` to animate — no other file needs editing. Recolor with a palette
 * spread (see BLUE_PALETTE); add frames only for poses the catalog lacks.
 * └────────────────────────────────────────────────────────────────────────┘
 */
type Rgb = readonly [number, number, number];

export type Palette = Record<string, Rgb | null>;
export const PET_SKIN_IDS = ["red", "blue"] as const;
export type PetSkinId = (typeof PET_SKIN_IDS)[number];
/** Every pet mode: "off" plus each skin id, in menu order. */
export const PET_MODE_IDS = ["off", ...PET_SKIN_IDS] as const;
export type PetMode = (typeof PET_MODE_IDS)[number];
/** Narrow an arbitrary string to a PetMode. */
export function isPetMode(value: string): value is PetMode {
	return (PET_MODE_IDS as readonly string[]).includes(value);
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
export const PARA_PARA_STEPS: ReadonlyArray<readonly [GajaePixelFrameName, number]> = [
	["danceL", 300],
	["danceR", 300],
	["base", 260],
	["flex", 480],
	["base", 260],
];

/**
 * A skin's idle burst: a short intro sequence, then an optional looping tail. It drives
 * BOTH the random live show-off AND the selector's preview demo, so give every skin a
 * real animation (reuse PARA_PARA_STEPS for a work-in intro) rather than one held frame.
 */
export interface PetBurst {
	/** Frames played once, in order, at the start of the burst. */
	intro: ReadonlyArray<readonly [GajaePixelFrameName, number]>;
	/** Frames cycled every `stepMs` for `ms` after the intro (a held or looping finish). */
	tail?: { frames: readonly GajaePixelFrameName[]; stepMs: number; ms: number };
}

/** Everything that defines a pet skin: identity, UI copy, colors and behavior. */
export interface PetSkin {
	id: PetSkinId;
	/** Selector/settings label, e.g. "RedGajae". */
	label: string;
	/** One-line selector/settings description. */
	description: string;
	palette: Palette;
	/** Idle burst animation played between quiet idle loops. */
	burst: PetBurst;
}

/** Skin registry — the single source for palettes, behavior and selector/command copy. */
export const PET_SKINS: Record<PetSkinId, PetSkin> = {
	red: {
		id: "red",
		label: "RedGajae",
		description: "The Red Crab, who likes to work-out.",
		palette: RED_PALETTE,
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
		burst: {
			intro: PARA_PARA_STEPS,
			tail: { frames: ["cry1", "cry2", "cry3"], stepMs: 110, ms: 990 },
		},
	},
};

/** Total burst duration (intro beats plus the looping tail). */
export function petBurstDurationMs(burst: PetBurst): number {
	const introMs = burst.intro.reduce((sum, [, ms]) => sum + ms, 0);
	return introMs + (burst.tail?.ms ?? 0);
}

/** The frame to show `elapsed` ms into a burst (`now` cycles the looping tail). */
export function petBurstFrame(burst: PetBurst, elapsed: number, now: number): GajaePixelFrameName {
	let t = elapsed;
	for (const [frame, ms] of burst.intro) {
		if (t < ms) return frame;
		t -= ms;
	}
	const tail = burst.tail;
	if (!tail) return burst.intro[burst.intro.length - 1][0];
	return tail.frames[Math.floor(now / tail.stepMs) % tail.frames.length];
}

/** Test-only access to logical art; production rendering still uses encoded frames. */
export const __gajaePetTestHooks = {
	getPixelGrid(name: GajaePixelFrameName): string[] {
		return [...PIXEL_GRIDS[name]];
	},
};

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
	frames: Record<GajaePixelFrameName, string>;
	/** protocol the frames were encoded for */
	protocol: "sixel" | "kitty";
	widthPx: number;
	heightPx: number;
	columns: number;
	rows: number;
	/** terminal rows touched by the encoded raster, including pixel offset */
	rasterRows: number;
}

/**
 * Build overlay pixel frames exactly `targetRows` terminal rows tall when the
 * terminal cells permit it. Nearest-neighbor sampling preserves the 16x16 art
 * while allowing fractional scale factors such as 36px / 16px.
 */
export function buildGajaePixelFrames(options: {
	protocol: "sixel" | "kitty";
	cellWidthPx: number;
	cellHeightPx: number;
	targetRows?: number;
	/** Transparent pixel offset above sixel art for sub-cell vertical placement. */
	sixelTopPaddingPx?: number;
	/** Native sub-cell `Y=` pixel offset that drops the kitty sprite within its first cell. */
	kittyCellYOffsetPx?: number;
	kittyImageId?: number;
	/** Color skin for the sprite palette (default "red"). */
	skin?: PetSkinId;
}): GajaePixelFrames {
	const targetRows = options.targetRows ?? 2;
	const gridSize = 16;
	const scale = Math.max(1, (targetRows * options.cellHeightPx) / gridSize);
	const widthPx = Math.round(gridSize * scale);
	const visibleHeightPx = Math.round(gridSize * scale);
	const columns = Math.ceil(widthPx / options.cellWidthPx);
	const rows = Math.ceil(visibleHeightPx / options.cellHeightPx);
	const allocatedHeightPx = rows * options.cellHeightPx;
	const topPaddingPx =
		allocatedHeightPx - visibleHeightPx + (options.protocol === "sixel" ? (options.sixelTopPaddingPx ?? 0) : 0);
	const heightPx = visibleHeightPx + topPaddingPx;
	const rasterRows = Math.ceil(heightPx / options.cellHeightPx);
	// Center the square sprite in its (cols * cellWidth) block, which the ceil()
	// column rounding can make wider than the sprite itself.
	const horizontalPaddingPx = Math.max(0, columns * options.cellWidthPx - widthPx);
	const leftPaddingPx = Math.floor(horizontalPaddingPx / 2);
	const rightPaddingPx = horizontalPaddingPx - leftPaddingPx;
	const imageId = options.kittyImageId ?? 0xc0de;
	const palette = PET_SKINS[options.skin ?? "red"].palette;
	const frames = {} as Record<GajaePixelFrameName, string>;
	for (const name of Object.keys(PIXEL_GRIDS) as GajaePixelFrameName[]) {
		frames[name] =
			options.protocol === "sixel"
				? encodeGridSixel(PIXEL_GRIDS[name], scale, topPaddingPx, palette)
				: encodeGridKitty(
						PIXEL_GRIDS[name],
						scale,
						imageId,
						columns,
						rows,
						topPaddingPx,
						options.kittyCellYOffsetPx ?? 0,
						leftPaddingPx,
						rightPaddingPx,
						palette,
					);
	}

	return { frames, protocol: options.protocol, widthPx, heightPx, columns, rows, rasterRows };
}
