import { describe, expect, it } from "bun:test";
import { evalToolDescriptionForSession, getEvalToolDescription } from "../../src/tools/session-descriptions";

describe("eval tool chaining guidance", () => {
	it("includes guidance on chaining tool calls within eval", () => {
		const description = getEvalToolDescription({ py: true, js: true });

		// Check for the "Chaining tools within eval" section
		expect(description).toContain("Chaining tools within eval");

		// Check for key guidance points
		expect(description).toContain("tool.<name>(args)");
		expect(description).toContain("permission and approval gates");
		expect(description).toContain("batch execution");
		expect(description).toContain("don't require human review");
		expect(description).toContain("read");
		expect(description).toContain("find");
		expect(description).toContain("search");
		expect(description).toContain("Avoid chaining");
		expect(description).toContain("single tool call");
		expect(description).toContain("result needs human review");
	});

	it("includes chaining guidance when both py and js backends are enabled", () => {
		const description = getEvalToolDescription({ py: true, js: true });
		expect(description).toContain("Chaining tools within eval");
	});

	it("includes chaining guidance when only py backend is enabled", () => {
		const description = getEvalToolDescription({ py: true, js: false });
		expect(description).toContain("Chaining tools within eval");
	});

	it("includes chaining guidance when only js backend is enabled", () => {
		const description = getEvalToolDescription({ py: false, js: true });
		expect(description).toContain("Chaining tools within eval");
	});

	it("returns eval description with session defaults when session is null", () => {
		const description = evalToolDescriptionForSession(null);
		expect(description).toContain("Chaining tools within eval");
	});

	it("returns eval description with session defaults when session is undefined", () => {
		const description = evalToolDescriptionForSession(undefined);
		expect(description).toContain("Chaining tools within eval");
	});

	it("mentions that permission checks apply to nested tool calls", () => {
		const description = getEvalToolDescription({ py: true, js: true });
		expect(description).toContain("permission and approval gates");
	});

	it("advises against chaining when single call suffices", () => {
		const description = getEvalToolDescription({ py: true, js: true });
		// Check for the guidance about when NOT to chain
		expect(description).toContain("Avoid chaining when a single tool call suffices");
	});

	it("advises against chaining operations that need human review", () => {
		const description = getEvalToolDescription({ py: true, js: true });
		expect(description).toContain("result needs human review");
		expect(description).toContain("edit");
	});

	it("provides examples of when chaining is appropriate (batch operations)", () => {
		const description = getEvalToolDescription({ py: true, js: true });
		expect(description).toContain("multiple reads");
		expect(description).toContain("loops over files");
		expect(description).toContain("filter/aggregate");
	});

	it("suggests splitting as the alternative to chaining", () => {
		const description = getEvalToolDescription({ py: true, js: true });
		expect(description).toContain("Split such operations into direct tool calls");
	});
});
