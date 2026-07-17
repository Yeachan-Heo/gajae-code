/**
 * Gajae pet: a tiny mood-reactive crustacean identity segment for the
 * status line.
 *
 * Mood resolution and frame selection are pure functions so the render path
 * stays cheap and unit-testable. The working claw-wiggle animation derives
 * its frame from the wall clock, so it needs no timers: it simply advances
 * whenever streaming re-renders the status line and freezes when idle.
 *
 * Every face is exactly the same visible width across moods and symbol
 * presets, so the pet never causes status-line layout jitter.
 */
import type { SymbolPreset, ThemeColor } from "../../theme/theme";
import type { ContextUsageLevel } from "./context-thresholds";

export type PetMood = "alarmed" | "working" | "tired" | "idle";

export interface PetMoodInput {
	/** An unacknowledged background job failure is latched. */
	jobsFailed: boolean;
	/** The agent is currently streaming a response. */
	streaming: boolean;
	/** Context usage level from the shared status-line thresholds. */
	contextLevel: ContextUsageLevel;
}

/** Milliseconds per claw-wiggle animation frame while working. */
export const PET_FRAME_MS = 600;

interface PetFaces {
	idle: string;
	working: readonly [string, string];
	tired: string;
	alarmed: string;
}

const UNICODE_FACES: PetFaces = {
	idle: "V(°ᴥ°)V",
	working: ["v(°ᴥ°)V", "V(°ᴥ°)v"],
	tired: "V(-ᴥ-)V",
	alarmed: "V(>ᴥ<)V",
};

const ASCII_FACES: PetFaces = {
	idle: "V(o.o)V",
	working: ["v(o.o)V", "V(o.o)v"],
	tired: "V(-.-)V",
	alarmed: "V(>.<)V",
};

/**
 * Resolve the pet's mood from session signals. Priority: an unacknowledged
 * job failure always alarms the pet; otherwise activity (streaming) wins over
 * context pressure; a heavy context (purple/error level) makes it tired.
 */
export function resolvePetMood(input: PetMoodInput): PetMood {
	if (input.jobsFailed) return "alarmed";
	if (input.streaming) return "working";
	if (input.contextLevel === "purple" || input.contextLevel === "error") return "tired";
	return "idle";
}

/** Pick the face for a mood, preset, and wall-clock time. */
export function getPetFrame(mood: PetMood, preset: SymbolPreset, now: number): string {
	const faces = preset === "ascii" ? ASCII_FACES : UNICODE_FACES;
	if (mood === "working") {
		return faces.working[Math.floor(now / PET_FRAME_MS) % 2];
	}
	return faces[mood];
}

/** Theme color slot for a mood; reuses semantic tokens so every theme works. */
export function getPetColor(mood: PetMood): ThemeColor {
	switch (mood) {
		case "alarmed":
			return "error";
		case "working":
			return "accent";
		case "tired":
			return "warning";
		case "idle":
			return "muted";
	}
}
