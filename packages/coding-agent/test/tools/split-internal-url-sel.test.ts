import { describe, expect, it } from "bun:test";
import { splitInternalUrlSel } from "@gajae-code/coding-agent/tools/path-utils";

describe("splitInternalUrlSel", () => {
	it("peels strict artifact selectors, including compounds", () => {
		expect(splitInternalUrlSel("artifact://3:1-100")).toEqual({ path: "artifact://3", sel: "1-100" });
		expect(splitInternalUrlSel("artifact://3:raw:1-100")).toEqual({ path: "artifact://3", sel: "raw:1-100" });
		expect(splitInternalUrlSel("artifact://3:1-100:raw")).toEqual({ path: "artifact://3", sel: "1-100:raw" });
	});

	it("peels every malformed artifact tail for pre-resolver rejection", () => {
		for (const sel of ["", "bogus", "raw:bogus", "-100", "raw:-100"]) {
			expect(splitInternalUrlSel(`artifact://3:${sel}`)).toEqual({ path: "artifact://3", sel });
		}
	});

	it("peels explicit authority selectors for identifier-shaped resources", () => {
		for (const scheme of ["agent", "artifact", "memory", "issue", "pr"]) {
			expect(splitInternalUrlSel(`${scheme}://namespace:raw:bogus`)).toEqual({
				path: `${scheme}://namespace`,
				sel: "raw:bogus",
			});
			expect(splitInternalUrlSel(`${scheme}://namespace:raw`)).toEqual({
				path: `${scheme}://namespace`,
				sel: "raw",
			});
			expect(splitInternalUrlSel(`${scheme}://namespace:raw:1-5`)).toEqual({
				path: `${scheme}://namespace`,
				sel: "raw:1-5",
			});
		}
	});

	it("preserves literal-colon authorities for path-like resources", () => {
		for (const scheme of ["local", "rule", "gjc"]) {
			expect(splitInternalUrlSel(`${scheme}://report:raw.txt`)).toEqual({
				path: `${scheme}://report:raw.txt`,
			});
		}
	});

	it("preserves ambiguous path-like authorities with URL suffixes", () => {
		for (const suffix of ["/nested.txt", "?query=value", "#fragment"]) {
			expect(splitInternalUrlSel(`local://report:raw${suffix}`)).toEqual({
				path: `local://report:raw${suffix}`,
			});
		}
	});

	it("does not turn empty authorities into selector-bearing root reads", () => {
		for (const scheme of ["agent", "artifact", "memory", "issue", "pr"]) {
			expect(splitInternalUrlSel(`${scheme}://:raw`)).toEqual({ path: `${scheme}://:raw` });
		}
	});

	it("does not classify path, query, or fragment data as selectors", () => {
		expect(splitInternalUrlSel("agent://reviewer_0/result:summary")).toEqual({
			path: "agent://reviewer_0/result:summary",
		});
		expect(splitInternalUrlSel('agent://reviewer_0?q=$.items[?(@.kind=="type:value")]')).toEqual({
			path: 'agent://reviewer_0?q=$.items[?(@.kind=="type:value")]',
		});
		expect(splitInternalUrlSel("issue://owner/repo?label=type:bug#comment:2")).toEqual({
			path: "issue://owner/repo?label=type:bug#comment:2",
		});
		expect(splitInternalUrlSel("pr://owner/repo?author=team:runtime")).toEqual({
			path: "pr://owner/repo?author=team:runtime",
		});
		expect(splitInternalUrlSel("agent://reviewer_0:bogus/result")).toEqual({
			path: "agent://reviewer_0/result",
			sel: "bogus",
		});
		expect(splitInternalUrlSel("artifact://3:bogus?range=1-2")).toEqual({
			path: "artifact://3?range=1-2",
			sel: "bogus",
		});
	});

	it("uses active skill names before interpreting selectors", () => {
		const activeSkillNames = ["namespace:raw", "namespace:1-5", "superpowers:brainstorming"];
		expect(splitInternalUrlSel("skill://namespace:raw", { activeSkillNames })).toEqual({
			path: "skill://namespace:raw",
		});
		expect(splitInternalUrlSel("skill://namespace:1-5", { activeSkillNames })).toEqual({
			path: "skill://namespace:1-5",
		});
		expect(splitInternalUrlSel("skill://superpowers:brainstorming:raw:-100", { activeSkillNames })).toEqual({
			path: "skill://superpowers:brainstorming",
			sel: "raw:-100",
		});
		expect(splitInternalUrlSel("skill://superpowers:brainstorming:", { activeSkillNames })).toEqual({
			path: "skill://superpowers:brainstorming",
			sel: "",
		});
		expect(splitInternalUrlSel("skill://superpowers%3Abrainstorming:bogus", { activeSkillNames })).toEqual({
			path: "skill://superpowers%3Abrainstorming",
			sel: "bogus",
		});
		expect(splitInternalUrlSel("skill://superpowers%3Abrainstorming:raw:bogus", { activeSkillNames })).toEqual({
			path: "skill://superpowers%3Abrainstorming",
			sel: "raw:bogus",
		});
		expect(splitInternalUrlSel("skill://superpowers%3Abrainstorming:%ZZ", { activeSkillNames })).toEqual({
			path: "skill://superpowers%3Abrainstorming",
			sel: "%ZZ",
		});
	});

	it("falls back to ordinary strict skill selectors without a registry", () => {
		expect(splitInternalUrlSel("skill://brainstorming:raw")).toEqual({
			path: "skill://brainstorming",
			sel: "raw",
		});
		expect(splitInternalUrlSel("skill://brainstorming:raw:1-5")).toEqual({
			path: "skill://brainstorming",
			sel: "raw:1-5",
		});
		expect(splitInternalUrlSel("skill://brainstorming:1-5:raw")).toEqual({
			path: "skill://brainstorming",
			sel: "1-5:raw",
		});
	});

	it("splits selectors from skill relative paths", () => {
		expect(splitInternalUrlSel("skill://foo/docs/reference.md:10-20")).toEqual({
			path: "skill://foo/docs/reference.md",
			sel: "10-20",
		});
		expect(splitInternalUrlSel("skill://foo/docs/reference.md:10-20?view=full#examples")).toEqual({
			path: "skill://foo/docs/reference.md?view=full#examples",
			sel: "10-20",
		});
		expect(
			splitInternalUrlSel("skill://namespace:foo/docs/reference.md:10-20", {
				activeSkillNames: ["namespace:foo"],
			}),
		).toEqual({
			path: "skill://namespace:foo/docs/reference.md",
			sel: "10-20",
		});
	});

	it("leaves non-URL and unknown-scheme strings alone", () => {
		expect(splitInternalUrlSel("/abs/path:1-50")).toEqual({ path: "/abs/path:1-50" });
		expect(splitInternalUrlSel("agent://1-50")).toEqual({ path: "agent://1-50" });
		expect(splitInternalUrlSel("http://example.com:1-50")).toEqual({ path: "http://example.com:1-50" });
		expect(splitInternalUrlSel("mcp://some/resource:1234")).toEqual({ path: "mcp://some/resource:1234" });
	});
});
