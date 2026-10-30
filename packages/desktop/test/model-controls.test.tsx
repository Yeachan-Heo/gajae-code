import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopModel, DesktopThinking } from "../../desktop-host/src/protocol";
import { filterDesktopModels, ModelPicker } from "../src/ModelPicker";
import { ReasoningSelect } from "../src/ReasoningSelect";

const models: DesktopModel[] = [
	{ id: "first/shared", provider: "first", name: "공통 코드 모델", contextWindow: 128000, reasoning: false, thinking: { options: [] } },
	{ id: "second/shared", provider: "second", name: "공통 코드 모델", contextWindow: 64000, reasoning: false, thinking: { options: [] } },
	{ id: "second/review-v2", provider: "second", name: "검토 전용", contextWindow: 32000, reasoning: false, thinking: { options: [] } },
];

const thinking: DesktopThinking = {
	level: "high",
	options: [
		{ value: "inherit", label: "상속" },
		{ value: "low", label: "낮음" },
		{ value: "high", label: "높음" },
	],
	available: true,
	scope: "session",
	mode: "effort",
};

describe("desktop model and reasoning controls", () => {
	test("combines provider, Korean name and model-ID terms without conflating equal names", () => {
		expect(filterDesktopModels(models, "  SECOND   공통 ").map(model => model.id)).toEqual(["second/shared"]);
		expect(filterDesktopModels(models, "review-V2 검토").map(model => model.id)).toEqual(["second/review-v2"]);
		expect(filterDesktopModels(models, "first review")).toEqual([]);
		expect(models.map(model => model.id)).toEqual(["first/shared", "second/shared", "second/review-v2"]);
	});

	test("treats punctuation as literal search text and preserves empty-catalog state", () => {
		expect(filterDesktopModels(models, ".*")).toEqual([]);
		expect(filterDesktopModels([], "shared")).toEqual([]);
	});

	test("preserves configured model identity when its catalog entry is unavailable", () => {
		for (const catalog of [[], models]) {
			const html = renderToStaticMarkup(<ModelPicker models={catalog} selectedId="unlisted/configured" disabled onSelect={() => {}} />);
			expect(html).toContain('aria-label="모델 선택: unlisted/configured"');
			expect(html).toContain('title="unlisted/configured"');
			expect(html).toContain(">unlisted/configured</span>");
			expect(html).not.toContain("선택되지 않음");
		}
		const absent = renderToStaticMarkup(<ModelPicker models={[]} onSelect={() => {}} />);
		expect(absent).toContain('aria-label="모델 선택: 선택되지 않음"');
	});

	test("renders only SDK-declared discrete reasoning choices and actual selected value", () => {
		const html = renderToStaticMarkup(<ReasoningSelect thinking={thinking} onChange={() => {}} />);
		// The control is a button-triggered listbox, never a native system select.
		expect(html).not.toContain("<select");
		expect(html).toContain('aria-haspopup="listbox"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("추론 수준: 높음");
		expect(html).not.toContain("추론 수준: 상속");
		expect(html).not.toContain('disabled=""');
	});

	test("keeps unsupported, always-on and pending controls disabled instead of promising a mutation", () => {
		const alwaysOn = renderToStaticMarkup(<ReasoningSelect thinking={{ level: null, options: [], available: false, scope: null, mode: "always-on" }} onChange={() => {}} />);
		expect(alwaysOn).toContain("추론 항상 켜짐");
		expect(alwaysOn).toContain('disabled=""');
		const pending = renderToStaticMarkup(<ReasoningSelect thinking={thinking} pending onChange={() => {}} />);
		expect(pending).toContain('disabled=""');
		const absent = renderToStaticMarkup(<ReasoningSelect onChange={() => {}} />);
		expect(absent).toContain("추론 설정 없음");
		expect(absent).toContain('disabled=""');
	});
});
