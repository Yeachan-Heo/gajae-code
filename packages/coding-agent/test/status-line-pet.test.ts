import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import {
	getPetColor,
	getPetFrame,
	PET_FRAME_MS,
	type PetMood,
	resolvePetMood,
} from "../src/modes/components/status-line/pet";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme, type SymbolPreset } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});
afterAll(() => {
	resetSettingsForTest();
});

function makeCtx(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: { state: {} } as unknown as SegmentContext["session"],
		width: 120,
		options: {},
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
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

describe("pet mood resolution", () => {
	test("job failure trumps everything", () => {
		expect(resolvePetMood({ jobsFailed: true, streaming: true, contextLevel: "error" })).toBe("alarmed");
	});

	test("streaming wins over context pressure", () => {
		expect(resolvePetMood({ jobsFailed: false, streaming: true, contextLevel: "purple" })).toBe("working");
	});

	test("heavy context makes the pet tired", () => {
		expect(resolvePetMood({ jobsFailed: false, streaming: false, contextLevel: "purple" })).toBe("tired");
		expect(resolvePetMood({ jobsFailed: false, streaming: false, contextLevel: "error" })).toBe("tired");
	});

	test("idle otherwise (normal and warning levels)", () => {
		expect(resolvePetMood({ jobsFailed: false, streaming: false, contextLevel: "normal" })).toBe("idle");
		expect(resolvePetMood({ jobsFailed: false, streaming: false, contextLevel: "warning" })).toBe("idle");
	});
});

describe("pet frames", () => {
	const moods: PetMood[] = ["idle", "working", "tired", "alarmed"];
	const presets: SymbolPreset[] = ["unicode", "nerd", "ascii"];

	test("working animation alternates claws on the frame clock", () => {
		const a = getPetFrame("working", "unicode", 0);
		const b = getPetFrame("working", "unicode", PET_FRAME_MS);
		const c = getPetFrame("working", "unicode", PET_FRAME_MS * 2);
		expect(a).not.toBe(b);
		expect(c).toBe(a);
	});

	test("non-working moods are time-invariant", () => {
		for (const mood of ["idle", "tired", "alarmed"] as const) {
			expect(getPetFrame(mood, "unicode", 0)).toBe(getPetFrame(mood, "unicode", PET_FRAME_MS));
		}
	});

	test("ascii preset uses ASCII-only faces", () => {
		for (const mood of moods) {
			const frame = getPetFrame(mood, "ascii", 0);
			expect(frame).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	test("every face has the same visible width (no layout jitter)", () => {
		const widths = new Set<number>();
		for (const preset of presets) {
			for (const mood of moods) {
				widths.add(Bun.stringWidth(getPetFrame(mood, preset, 0)));
				widths.add(Bun.stringWidth(getPetFrame(mood, preset, PET_FRAME_MS)));
			}
		}
		expect(widths.size).toBe(1);
	});

	test("each mood maps to a distinct semantic color slot", () => {
		expect(new Set(moods.map(getPetColor)).size).toBe(moods.length);
	});
});

describe("pet status-line segment", () => {
	test("visible and idle by default", () => {
		const rendered = renderSegment("pet", makeCtx());
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(getPetFrame("idle", "unicode", 0));
	});

	test("alarmed on latched job failure", () => {
		const rendered = renderSegment(
			"pet",
			makeCtx({ jobs: { ...EMPTY_JOBS_SNAPSHOT, worstState: "failed", failedUnacknowledged: true } }),
		);
		expect(Bun.stripANSI(rendered.content)).toBe(getPetFrame("alarmed", "unicode", 0));
	});

	test("working while the session streams", () => {
		const ctx = makeCtx({
			session: { state: {}, isStreaming: true } as unknown as SegmentContext["session"],
		});
		const face = Bun.stripANSI(renderSegment("pet", ctx).content);
		const frames = [getPetFrame("working", "unicode", 0), getPetFrame("working", "unicode", PET_FRAME_MS)];
		expect(frames).toContain(face);
	});

	test("tired under heavy context pressure", () => {
		const rendered = renderSegment("pet", makeCtx({ contextPercent: 75, contextWindow: 400_000 }));
		expect(Bun.stripANSI(rendered.content)).toBe(getPetFrame("tired", "unicode", 0));
	});
});
