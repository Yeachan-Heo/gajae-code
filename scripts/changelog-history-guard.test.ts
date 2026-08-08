import { describe, expect, test } from "bun:test";
import { compareHistory, formatViolation, releaseHeadings } from "./changelog-history-guard";

const FULL = `# Changelog

## [Unreleased]

### Fixed

- Something new.

## [0.12.12] - 2026-08-05

### Fixed

- An older fix.

## [0.12.11] - 2026-08-03

### Added

- An even older feature.
`;

describe("releaseHeadings", () => {
	test("collects released versions and skips Unreleased", () => {
		expect(releaseHeadings(FULL)).toEqual(["0.12.12", "0.12.11"]);
	});

	test("treats Unreleased case-insensitively", () => {
		expect(releaseHeadings("## [unreleased]\n## [1.0.0] - 2026-01-01\n")).toEqual(["1.0.0"]);
	});

	test("returns nothing for an emptied file", () => {
		// The exact shape produced by the bad rebase resolutions this guard exists for.
		expect(releaseHeadings("\n")).toEqual([]);
	});
});

describe("compareHistory", () => {
	test("passes when an entry is added under Unreleased", () => {
		const head = FULL.replace("- Something new.", "- Something new.\n- Something newer.");
		expect(compareHistory("packages/x/CHANGELOG.md", FULL, head)).toBeUndefined();
	});

	test("passes when a release commit consumes Unreleased into a new version", () => {
		const head = FULL.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [0.12.13] - 2026-08-06\n");
		expect(compareHistory("packages/x/CHANGELOG.md", FULL, head)).toBeUndefined();
	});

	test("catches a fully emptied changelog", () => {
		const violation = compareHistory("packages/coding-agent/CHANGELOG.md", FULL, "\n");
		expect(violation).toBeDefined();
		expect(violation?.removed).toEqual(["0.12.12", "0.12.11"]);
		expect(violation?.baseHeadingCount).toBe(2);
		expect(violation?.headHeadingCount).toBe(0);
	});

	test("catches a single dropped released section", () => {
		const head = FULL.replace("## [0.12.11] - 2026-08-03\n\n### Added\n\n- An even older feature.\n", "");
		const violation = compareHistory("packages/x/CHANGELOG.md", FULL, head);
		expect(violation?.removed).toEqual(["0.12.11"]);
	});

	test("ignores a file absent at the base", () => {
		expect(compareHistory("packages/x/CHANGELOG.md", undefined, FULL)).toBeUndefined();
	});

	test("catches a changelog deleted at the head", () => {
		const violation = compareHistory("packages/x/CHANGELOG.md", FULL, undefined);
		expect(violation?.removed).toEqual(["0.12.12", "0.12.11"]);
		expect(violation?.baseHeadingCount).toBe(2);
		expect(violation?.headHeadingCount).toBe(0);
	});

	test("does not flag reordering or rewording that keeps every version", () => {
		const head = FULL.replace("- An older fix.", "- An older fix, reworded.");
		expect(compareHistory("packages/x/CHANGELOG.md", FULL, head)).toBeUndefined();
	});
});

describe("formatViolation", () => {
	test("names the recovery command and the counts", () => {
		const message = formatViolation({
			file: "packages/coding-agent/CHANGELOG.md",
			removed: ["0.12.12", "0.12.11"],
			baseHeadingCount: 2,
			headHeadingCount: 0,
		});
		expect(message).toContain("removes 2 released section(s): 0.12.12, 0.12.11");
		expect(message).toContain("Base had 2 released headings, this head has 0");
		expect(message).toContain("git checkout");
		expect(message).toContain("packages/coding-agent/CHANGELOG.md");
	});

	test("summarizes instead of listing every version when many are lost", () => {
		const removed = Array.from({ length: 12 }, (_, index) => `0.1.${index}`);
		const message = formatViolation({
			file: "packages/x/CHANGELOG.md",
			removed,
			baseHeadingCount: 12,
			headHeadingCount: 0,
		});
		expect(message).toContain("(+4 more)");
		expect(message).not.toContain("0.1.11");
	});
});
