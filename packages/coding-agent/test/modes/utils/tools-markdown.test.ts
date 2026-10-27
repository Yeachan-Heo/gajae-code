import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { buildToolsMarkdown } from "../../../src/modes/utils/tools-markdown";

const OSC_CLIPBOARD = "\x1b]52;c;AQIDBA==\x07";
const OSC_TITLE = "\x1b]0;not-a-title\x07";
const OSC_LINK = "\x1b]8;;http://example.invalid\x07click\x1b]8;;\x07";
const CSI_ERASE = "\x1b[2J";
const CSI_CURSOR = "\x1b[10;1H";
const C1_OSC = "\u009d0;c1-title\u009c";

/** C0 except tab and LF, plus DEL and C1. The table itself is joined with LF. */
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

function legacyCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " ")
		.trim();
}

describe("buildToolsMarkdown", () => {
	it("drops an OSC clipboard sequence from a tool description", () => {
		const markdown = buildToolsMarkdown({
			tools: [{ name: "read", description: `keep${OSC_CLIPBOARD}visible` }],
		});
		expect(markdown.includes(OSC_CLIPBOARD)).toBe(false);
		expect(markdown.includes("\x1b]52")).toBe(false);
		expect(markdown.includes("AQIDBA==")).toBe(false);
		expect(markdown.includes("\x1b")).toBe(false);
		expect(TERMINAL_CONTROL.test(markdown)).toBe(false);
		expect(markdown).toContain("| `read` | keepvisible |");
		const only = buildToolsMarkdown({
			tools: [{ name: "read", description: OSC_CLIPBOARD }],
		});
		expect(only.includes("\x1b")).toBe(false);
		expect(only.includes("AQIDBA==")).toBe(false);
		expect(only).toContain("| `read` | No description provided. |");
	});

	it("drops OSC title, OSC link, CSI, and C1 from the name and the description", () => {
		const markdown = buildToolsMarkdown({
			tools: [
				{
					name: `ssh${OSC_TITLE}`,
					description: `before${OSC_LINK}${CSI_ERASE}${CSI_CURSOR}${C1_OSC}after`,
				},
			],
		});
		expect(markdown.includes(OSC_TITLE)).toBe(false);
		expect(markdown.includes("\x1b]0;")).toBe(false);
		expect(markdown.includes("not-a-title")).toBe(false);
		expect(markdown.includes(OSC_LINK)).toBe(false);
		expect(markdown.includes("\x1b]8;;")).toBe(false);
		expect(markdown.includes(CSI_ERASE)).toBe(false);
		expect(markdown.includes(CSI_CURSOR)).toBe(false);
		expect(markdown.includes("\u009d")).toBe(false);
		expect(markdown.includes("\u009c")).toBe(false);
		expect(markdown.includes("\x1b")).toBe(false);
		expect(markdown).toContain("| `ssh` | beforeclickafter |");
	});

	it("drops a C1 introducer when the description has no ESC", () => {
		const markdown = buildToolsMarkdown({
			tools: [{ name: "read", description: `keep${C1_OSC}visible` }],
		});
		expect(markdown.includes("\u009d")).toBe(false);
		expect(markdown.includes("\u009c")).toBe(false);
		expect(markdown.includes("\x1b")).toBe(false);
		expect(markdown).toContain("| `read` | keep0;c1-titlevisible |");
	});

	it("still renders an ordinary name, pipes, newlines, and a tab", () => {
		const markdown = buildToolsMarkdown({
			tools: [
				{
					name: "read",
					description: "Reads a | file\nfrom disk.\tKeep MixedCase.",
				},
			],
		});
		expect(markdown).toBe(
			[
				"| Tool | Description |",
				"|------|-------------|",
				"| `read` | Reads a \\| file from disk.\tKeep MixedCase. |",
			].join("\n"),
		);
	});

	it("still uses the empty-list and empty-description sentences", () => {
		expect(buildToolsMarkdown({ tools: [] })).toBe("No tools are currently visible to the agent.");
		const markdown = buildToolsMarkdown({
			tools: [
				{ name: "bash", description: "   \n  " },
				{ name: "grep", description: "Find text" },
			],
		});
		expect(markdown).toContain("| `bash` | No description provided. |");
		expect(markdown).toContain("| `grep` | Find text |");
	});

	it("replaces a lone carriage return with a space", () => {
		const markdown = buildToolsMarkdown({
			tools: [{ name: "read", description: "left\rright" }],
		});
		expect(markdown.includes("\r")).toBe(false);
		expect(markdown).toContain("| `read` | left right |");
	});

	it("still keeps a tool name that contains a pipe inside the code span", () => {
		const markdown = buildToolsMarkdown({
			tools: [{ name: "a|b", description: "plain" }],
		});
		expect(markdown).toContain("| `a|b` | plain |");
	});

	it("property: control-free cells match the pipe and newline rules, fc.property seed 69026, numRuns 64", () => {
		const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9._-]{0,16}$/);
		const description = fc.string({ maxLength: 48 }).filter(value => {
			return value.toWellFormed() === value && !/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u.test(value);
		});
		fc.assert(
			fc.property(name, description, (toolName, toolDescription) => {
				const markdown = buildToolsMarkdown({
					tools: [{ name: toolName, description: toolDescription }],
				});
				const expected = legacyCell(toolDescription) || "No description provided.";
				expect(markdown).toContain(`| \`${toolName}\` | ${expected} |`);
				expect(TERMINAL_CONTROL.test(markdown)).toBe(false);
			}),
			{ seed: 69026, numRuns: 64 },
		);
	});

	it("property: injected terminal controls are absent from the table, fc.property seed 69027, numRuns 64", () => {
		const token = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/);
		const wrapper = fc.constantFrom(
			(value: string) => `\x1b]52;c;${value}\x07`,
			(value: string) => `\x1b]0;${value}\x07`,
			(value: string) => `\x1b]8;;http://example.invalid/${value}\x07`,
			(value: string) => `\x1b[31m${value}\x1b[0m`,
			(value: string) => `\u009d${value}\u009c`,
		);
		fc.assert(
			fc.property(token, wrapper, (mark, wrap) => {
				const sequence = wrap(mark);
				const markdown = buildToolsMarkdown({
					tools: [{ name: `tool${sequence}`, description: `keep${sequence}tail` }],
				});
				expect(markdown.includes(sequence)).toBe(false);
				expect(markdown.includes("\x1b")).toBe(false);
				expect(markdown.includes("\u009d")).toBe(false);
				expect(markdown.includes("\u009c")).toBe(false);
				expect(TERMINAL_CONTROL.test(markdown)).toBe(false);
				expect(markdown).toContain("keep");
				expect(markdown).toContain("tail");
				expect(markdown).toContain("`tool");
			}),
			{ seed: 69027, numRuns: 64 },
		);
	});
});
