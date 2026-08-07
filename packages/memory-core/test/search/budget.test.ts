import { describe, expect, it } from "bun:test";

import {
	createSearchBudget,
	dropCandidate,
	reserveChars,
	reserveFile,
	reserveMap,
	reserveSection,
	SEARCH_BUDGET_LIMITS,
} from "../../src/search/budget";

describe("M2 search budget", () => {
	it("uses the exact fixed map, file, section, and character limits", () => {
		const state = createSearchBudget();
		expect(state.limits).toEqual({ maxMaps: 4, maxFiles: 20, maxSections: 8, maxChars: 24_000 });
		expect(SEARCH_BUDGET_LIMITS).toEqual({ maxMaps: 4, maxFiles: 20, maxSections: 8, maxChars: 24_000 });

		let maps = state;
		for (let index = 0; index < 4; index += 1) {
			const reservation = reserveMap(maps, 1, `map-${index}`);
			expect(reservation.accepted).toBe(true);
			maps = reservation.state;
		}
		expect(maps.usage.maps).toBe(4);
		const fifthMap = reserveMap(maps, 1, "map-overflow");
		expect(fifthMap.accepted).toBe(false);
		expect(fifthMap.state.usage.maps).toBe(4);
		expect(fifthMap.state.truncated).toBe(true);

		let files = state;
		for (let index = 0; index < 20; index += 1) {
			const reservation = reserveFile(files, 1, `file-${index}`);
			expect(reservation.accepted).toBe(true);
			files = reservation.state;
		}
		expect(files.usage.files).toBe(20);
		expect(reserveFile(files, 1, "file-overflow").accepted).toBe(false);

		let sections = state;
		for (let index = 0; index < 8; index += 1) {
			const reservation = reserveSection(sections, 1, `section-${index}`);
			expect(reservation.accepted).toBe(true);
			sections = reservation.state;
		}
		expect(sections.usage.sections).toBe(8);
		expect(reserveSection(sections, 1, "section-overflow").accepted).toBe(false);

		let chars = state;
		const exactChars = reserveChars(chars, 24_000, "document-body");
		expect(exactChars.accepted).toBe(true);
		chars = exactChars.state;
		expect(chars.usage.chars).toBe(24_000);
		const extraChar = reserveChars(chars, 1, "document-body-overflow");
		expect(extraChar.accepted).toBe(false);
		expect(extraChar.state.usage.chars).toBe(24_000);
		expect(extraChar.state.truncated).toBe(true);
	});

	it("only tightens custom limits and records truncation without consuming usage", () => {
		const state = createSearchBudget({ maxMaps: 0, maxFiles: 2, maxSections: 1, maxChars: 3 });
		const noMap = reserveMap(state, 1, "map-disabled");
		expect(noMap.accepted).toBe(false);
		expect(noMap.state.usage).toEqual({ maps: 0, files: 0, sections: 0, chars: 0 });
		expect(noMap.state.droppedCandidates).toEqual(["map-disabled"]);
		expect(noMap.state.drops).toEqual([
			{ candidateId: "map-disabled", dimension: "maps", amount: 1, reason: "limit" },
		]);

		const firstFile = reserveFile(noMap.state, 2, "files");
		expect(firstFile.accepted).toBe(true);
		const overFile = reserveFile(firstFile.state, 1, "file-overflow");
		expect(overFile.accepted).toBe(false);
		expect(overFile.state.usage.files).toBe(2);
		expect(overFile.state.droppedCandidates).toEqual(["map-disabled", "file-overflow"]);

		const dropped = dropCandidate(overFile.state, "cafe\u0301", "files");
		expect(dropped.usage).toEqual(overFile.state.usage);
		expect(dropped.droppedCandidates.at(-1)).toBe("café");
		expect(dropped.truncated).toBe(true);

		const clamped = createSearchBudget({ maxFiles: 99, maxChars: 99_999 });
		expect(clamped.limits.maxFiles).toBe(20);
		expect(clamped.limits.maxChars).toBe(24_000);
		expect(createSearchBudget({ maxFiles: 1.5, maxChars: Number.NaN }).limits).toEqual(SEARCH_BUDGET_LIMITS);
	});

	it("fails closed for invalid amounts and canonicalizes candidate ids", () => {
		const cases = [
			{ amount: Number.NaN, expectedAmount: 0 },
			{ amount: Number.POSITIVE_INFINITY, expectedAmount: 0 },
			{ amount: -1, expectedAmount: 0 },
			{ amount: 1.5, expectedAmount: 1.5 },
		];
		let state = createSearchBudget();
		for (const [index, candidate] of cases.entries()) {
			const reservation = reserveFile(state, candidate.amount, index === 0 ? "cafe\u0301" : `bad-${index}`);
			expect(reservation.accepted).toBe(false);
			expect(reservation.state.truncated).toBe(true);
			expect(reservation.state.drops.at(-1)).toEqual({
				candidateId: index === 0 ? "café" : `bad-${index}`,
				dimension: "files",
				amount: candidate.expectedAmount,
				reason: "invalid-amount",
			});
			state = reservation.state;
		}
		expect(state.usage.files).toBe(0);
		expect(state.droppedCandidates).toEqual(["café", "bad-1", "bad-2", "bad-3"]);
	});
});
