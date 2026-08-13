import frames from "./ouroboros-pet-frames.json" with { type: "json" };

export const OUROBOROS_FRAME_NAMES = [
	"idle",
	"tongue-1",
	"tongue-2",
	"blink",
	"cry-1",
	"cry-2",
	"cry-3",
	"heart-turn-0",
	"heart-turn-1",
	"heart-turn-3",
	"heart-turn-4",
	"heart-turn-5",
	"heart-turn-6",
	"heart-turn-10",
	"heart-turn-11",
	"heart",
	"heart-accent",
	"enter-1",
	"enter-2",
	"spin-1",
	"spin-2",
	"spin-3",
	"spin-4",
	"spin-5",
	"spin-6",
	"spin-7",
	"spin-8",
] as const;

export type OuroborosFrameName = (typeof OUROBOROS_FRAME_NAMES)[number];

export const OUROBOROS_PIXEL_GRIDS: Record<OuroborosFrameName, string[]> = frames;

/** Quiet loop with frequent tongue flicks and an occasional three-drop sob. */
export const OUROBOROS_IDLE_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["idle", 1400],
	["blink", 120],
	["idle", 500],
	["tongue-1", 110],
	["tongue-2", 150],
	["tongue-1", 90],
	["idle", 1600],
	["tongue-1", 110],
	["tongue-2", 150],
	["tongue-1", 90],
	["idle", 2200],
	["blink", 120],
	["idle", 900],
	["tongue-1", 110],
	["tongue-2", 150],
	["tongue-1", 90],
	["idle", 1800],
	["cry-1", 180],
	["cry-2", 180],
	["cry-3", 320],
	["cry-2", 180],
	["cry-3", 320],
	["cry-2", 180],
	["cry-3", 420],
	["idle", 1600],
];

/** One sob builds into three distinct tear drops: 1-2-3-2-3-2-3. */
export const OUROBOROS_CRY_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["cry-1", 180],
	["cry-2", 180],
	["cry-3", 320],
	["cry-2", 180],
	["cry-3", 320],
	["cry-2", 180],
	["cry-3", 420],
];

/**
 * Signature flex: the eye opens before the body rolls counterclockwise through
 * 45°, 90°, 120°, and the final overlap with the heart pose. The return reuses
 * the authored frames in reverse.
 */
export const OUROBOROS_HEART_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["heart-turn-0", 100],
	["heart-turn-1", 110],
	["heart-turn-3", 110],
	["heart-turn-4", 110],
	["heart-turn-5", 110],
	["heart-turn-6", 110],
	["heart-turn-10", 110],
	["heart-turn-11", 110],
	["heart", 300],
	["heart-accent", 160],
	["heart", 110],
	["heart-accent", 160],
	["heart", 350],
	["heart-turn-11", 100],
	["heart-turn-10", 100],
	["heart-turn-6", 100],
	["heart-turn-5", 100],
	["heart-turn-4", 100],
	["heart-turn-3", 100],
	["heart-turn-1", 100],
	["heart-turn-0", 100],
	["idle", 500],
];

/** Head leads left while the resting coil resolves into the infinity loop. */
export const OUROBOROS_WORK_ENTER_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["enter-1", 120],
	["enter-2", 120],
];

/** The exact inverse of work entry, so stopping visibly unwinds into idle. */
export const OUROBOROS_WORK_EXIT_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["enter-2", 110],
	["enter-1", 120],
	["idle", 160],
];

/** Retouched eight-frame infinity loop with the full body following the head. */
export const OUROBOROS_WORK_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["spin-1", 220],
	["spin-2", 220],
	["spin-3", 220],
	["spin-4", 220],
	["spin-5", 220],
	["spin-6", 220],
	["spin-7", 220],
	["spin-8", 220],
];

/** Leave the infinity loop, perform the heart flourish, then resolve back into it. */
export const OUROBOROS_WORK_HEART_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["enter-2", 110],
	["enter-1", 120],
	...OUROBOROS_HEART_STEPS,
	["enter-1", 120],
	["enter-2", 140],
];

/** Leave the infinity loop for a three-drop sob, then resume at full size. */
export const OUROBOROS_WORK_CRY_STEPS: ReadonlyArray<readonly [OuroborosFrameName, number]> = [
	["enter-2", 110],
	["enter-1", 120],
	["idle", 120],
	...OUROBOROS_CRY_STEPS,
	["idle", 220],
	["enter-1", 120],
	["enter-2", 140],
];
