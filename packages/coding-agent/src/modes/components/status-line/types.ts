import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../../config/settings-schema";
import type { AgentSession } from "../../../session/agent-session";
import type { JobsSnapshot } from "../../jobs-observer";
import type { StatusLineSegmentOptions, StatusLineSettings } from "../status-line";

export type {
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSeparatorStyle,
	StatusLineSettings,
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Rendering
// ═══════════════════════════════════════════════════════════════════════════

export type RGB = readonly [number, number, number];

export interface SegmentContext {
	session: AgentSession;
	width: number;
	options: StatusLineSegmentOptions;
	planMode: {
		enabled: boolean;
		paused: boolean;
	} | null;
	goalMode: {
		enabled: boolean;
		paused: boolean;
	} | null;
	// Cached values for performance (computed once per render)
	usageStats: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		premiumRequests: number;
		cost: number;
		tokensPerSecond: number | null;
	};
	contextPercent: number;
	contextWindow: number;
	autoCompactEnabled: boolean;
	subagentCount: number;
	jobs: JobsSnapshot;
	sessionStartTime: number;
	git: {
		branch: string | null;
		status: { staged: number; unstaged: number; untracked: number } | null;
		pr: { number: number; url: string } | null;
	};
	usage: {
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null;
}

export interface RenderedSegment {
	content: string; // The segment text (may include ANSI color codes)
	visible: boolean; // Whether to render (e.g., git hidden when not in repo)
}

export interface StatusLineSegment {
	id: StatusLineSegmentId;
	render(ctx: SegmentContext): RenderedSegment;
}

// ═══════════════════════════════════════════════════════════════════════════
// Separator Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface SeparatorDef {
	left: string; // Character for left→right segments
	right: string; // Character for right→left segments (reversed)
	endCaps?: {
		left: string; // Cap for right segments (points left)
		right: string; // Cap for left segments (points right)
		useBgAsFg: boolean;
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Preset Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface PresetDef {
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	separator: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
}
