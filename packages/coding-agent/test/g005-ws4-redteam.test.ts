import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	PLAN_REVIEW_ACTIONS,
	PlanPreviewOverlay,
	planSnapshotHash,
	serializePlanReviewComments,
} from "../src/modes/components/plan-preview-overlay";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => initTheme());

const comment = (snapshotHash: string, startLine: number, endLine: number, text = "Review this") => ({
	id: `${startLine}-${endLine}`,
	startLine,
	endLine,
	text,
	snapshotHash,
	createdAt: 1,
});

describe("G005 WS4 red-team", () => {
	it("pages a 5,000-line Unicode plan without changing its content hash", () => {
		const content = Array.from({ length: 5_000 }, (_, index) => `${index + 1}: 計画 🚀`).join("\n");
		const overlay = new PlanPreviewOverlay(
			content,
			() => {},
			() => {},
		);
		expect(overlay.snapshotHash).toBe(createHash("sha256").update(content).digest("hex"));
		for (let index = 0; index < 10; index++) overlay.handleInput("\x1b[6~");
		expect(overlay.pageOffset).toBeGreaterThan(0);
		expect(overlay.render(20).every(line => Bun.stripANSI(line).length <= 20)).toBe(true);
	});

	it("uses SHA-256's first eight hexadecimal characters and preserves comment order", () => {
		const content = "α\nβ\nγ";
		const hash = planSnapshotHash(content);
		const output = serializePlanReviewComments(
			content,
			hash,
			[comment(hash, 1, 1, "first"), comment(hash, 2, 3, "second")],
			"last note",
		);
		expect(hash.slice(0, 8)).toBe(createHash("sha256").update(content).digest("hex").slice(0, 8));
		expect(output).toBe(
			`Plan review comments (snapshot ${hash.slice(0, 8)}):\n- L1: first\n> α\n- L2-L3: second\n> β\n> γ\nlast note`,
		);
	});

	it("clips a valid end past EOF but rejects invalid starts", () => {
		const content = "one\ntwo";
		const hash = planSnapshotHash(content);
		expect(serializePlanReviewComments(content, hash, [comment(hash, 2, 99)])).toBe(
			`Plan review comments (snapshot ${hash.slice(0, 8)}):\n- L2: Review this\n> two`,
		);
		expect(serializePlanReviewComments(content, hash, [comment(hash, 0, 1), comment(hash, 3, 3)])).toBe("");
	});

	it("serializes CRLF referenced lines as display lines, not embedded carriage-return bytes", () => {
		const content = "第一行\r\n第二行\r\n第三行";
		const hash = planSnapshotHash(content);
		const output = serializePlanReviewComments(content, hash, [comment(hash, 1, 2, "CJK")]);
		expect(output).toBe(`Plan review comments (snapshot ${hash.slice(0, 8)}):\n- L1-L2: CJK\n> 第一行\n> 第二行`);
	});

	it("renders all four actions in an empty-plan state at minimum width", () => {
		const overlay = new PlanPreviewOverlay(
			null,
			() => {},
			() => {},
		);
		const rendered = Bun.stripANSI(overlay.render(20).join("\n"));
		for (const action of PLAN_REVIEW_ACTIONS) expect(rendered).toContain(action);
	});
});
