import { beforeAll, describe, expect, it } from "bun:test";
import { sanitizeText } from "@gajae-code/utils";
import fc from "fast-check";
import type { Rule } from "../../../src/capability/rule";
import type { SourceMeta } from "../../../src/capability/types";
import { TtsrNotificationComponent } from "../../../src/modes/components/ttsr-notification";
import { initTheme } from "../../../src/modes/theme/theme";

const source: SourceMeta = {
	provider: "gjc",
	providerName: "gjc",
	path: "rules/sample.md",
	level: "project",
};

const OSC_CLIPBOARD = "\x1b]52;c;AQIDBA==\x07";
const OSC_TITLE = "\x1b]0;not-a-title\x07";
const OSC_LINK = "\x1b]8;;http://example.invalid\x1b\\";
const CSI_ERASE = "\x1b[2J";

function rule(overrides: Partial<Rule> & Pick<Rule, "name" | "content">): Rule {
	return {
		path: "rules/sample.md",
		_source: source,
		...overrides,
	};
}

function render(rules: Rule[], expanded = false): string {
	const component = new TtsrNotificationComponent(rules);
	if (expanded) component.setExpanded(true);
	return component.render(160).join("\n");
}

beforeAll(async () => {
	await initTheme(false);
});

describe("TtsrNotificationComponent", () => {
	it("does not draw a terminal control sequence in a rule description", () => {
		const raw = render([
			rule({
				name: "review",
				description: `keep this${OSC_CLIPBOARD}visible`,
				content: "unused body",
			}),
		]);
		expect(raw.includes(OSC_CLIPBOARD)).toBe(false);
		expect(raw.includes("\x1b]52")).toBe(false);
		expect(raw.includes("AQIDBA==")).toBe(false);
		const visible = Bun.stripANSI(raw);
		expect(visible).toContain("keep this");
		expect(visible).toContain("visible");
		expect(visible).toContain("review");
		expect(visible).not.toContain("unused body");
	});

	it("does not draw terminal controls in the rule name or body", () => {
		const raw = render([
			rule({
				name: `rule${OSC_LINK}name`,
				content: `body${OSC_TITLE}${CSI_ERASE}text`,
			}),
		]);
		expect(raw.includes(OSC_LINK)).toBe(false);
		expect(raw.includes("\x1b]8;;")).toBe(false);
		expect(raw.includes(OSC_TITLE)).toBe(false);
		expect(raw.includes("\x1b]0;")).toBe(false);
		expect(raw.includes(CSI_ERASE)).toBe(false);
		const visible = Bun.stripANSI(raw);
		expect(visible).toContain("rulename");
		expect(visible).toContain("bodytext");
	});

	it("still draws a plain multi-line description and the expand hint", () => {
		const description = "First line stays.\nSecond line stays.\nThird line stays hidden.";
		const sample = [rule({ name: "plain-rule", description, content: "fallback body" })];
		const collapsed = Bun.stripANSI(render(sample));
		expect(collapsed).toContain("plain-rule");
		expect(collapsed).toContain("First line stays.");
		expect(collapsed).toContain("Second line stays.");
		expect(collapsed).not.toContain("Third line stays hidden.");
		expect(collapsed).toContain("ctrl+o to expand");
		expect(collapsed).not.toContain("fallback body");
		const expanded = Bun.stripANSI(render(sample, true));
		expect(expanded).toContain("Third line stays hidden.");
		expect(expanded).not.toContain("ctrl+o to expand");
	});

	it("still draws tabs, punctuation, and a body used when description is absent", () => {
		const punctuated = Bun.stripANSI(
			render([
				rule({
					name: "punct",
					description: "Keep\ttabs, (parens), and 100% of this line.",
					content: "not shown",
				}),
			]),
		);
		expect(punctuated).toContain("Keep");
		expect(punctuated).toContain("tabs, (parens), and 100% of this line.");
		expect(punctuated).not.toContain("not shown");

		const bodyOnly = Bun.stripANSI(render([rule({ name: "body-only", content: "Body line one.\nBody line two." })]));
		expect(bodyOnly).toContain("body-only");
		expect(bodyOnly).toContain("Body line one.");
		expect(bodyOnly).toContain("Body line two.");
	});

	it("property: drawn rule text matches sanitizeText and drops OSC, seed 691202610, 64 inputs", () => {
		const printable = fc.string({ maxLength: 20 }).filter(value => /^[\x20-\x7e]*$/u.test(value));
		fc.assert(
			fc.property(printable, printable, printable, (name, description, content) => {
				const attackName = `${name}${OSC_CLIPBOARD}`;
				const attackDescription = `${description}${OSC_TITLE}${CSI_ERASE}`;
				const attackContent = `${content}${OSC_LINK}${CSI_ERASE}`;
				const attacked = render(
					[
						rule({
							name: attackName,
							description: description.length > 0 ? attackDescription : undefined,
							content: attackContent,
						}),
					],
					true,
				);
				expect(attacked.includes(OSC_CLIPBOARD)).toBe(false);
				expect(attacked.includes(OSC_TITLE)).toBe(false);
				expect(attacked.includes(OSC_LINK)).toBe(false);
				expect(attacked.includes(CSI_ERASE)).toBe(false);
				expect(attacked.includes("\x1b]")).toBe(false);
				const visible = Bun.stripANSI(attacked);
				const safeName = sanitizeText(name).trim();
				const safeBody = sanitizeText(description.length > 0 ? description : content).trim();
				if (safeName.length > 0) expect(visible).toContain(safeName);
				if (safeBody.length > 0) expect(visible).toContain(safeBody);
			}),
			{ seed: 691202610, numRuns: 64 },
		);
	});
});
