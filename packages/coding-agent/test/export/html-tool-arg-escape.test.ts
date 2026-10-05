import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const templateJs = readFileSync(new URL("../../src/export/html/template.js", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
	const signature = `function ${name}(`;
	const start = source.indexOf(signature);
	if (start < 0) throw new Error(`missing ${name}`);
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

function escapeHtml(text: unknown): string {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function load(name: string, extras: Record<string, unknown> = {}) {
	const body = extractFunction(templateJs, name);
	const params = [
		"escapeHtml",
		"shortenPath",
		"invalidArgHtml",
		"toolHead",
		"str",
		"todoRoman",
		"truncate",
		...Object.keys(extras),
	];
	const fn = new Function(...params, `${body}\nreturn ${name};`) as (...args: unknown[]) => unknown;
	return fn(
		escapeHtml,
		(value: unknown) => String(value ?? ""),
		() => '<span class="tool-error">[invalid arg]</span>',
		(label: string) => `<div class="tool-header"><span class="tool-name">${escapeHtml(label)}</span></div>`,
		(value: unknown) => (value == null ? "" : String(value)),
		(n: number) => String(n),
		(value: string) => value,
		...Object.values(extras),
	);
}

describe("session HTML tool argument escaping", () => {
	it("keeps numeric read ranges as text", () => {
		const pathDisplay = load("pathDisplay") as (filePath: string, offset?: number, limit?: number) => string;
		expect(pathDisplay("src/app.ts", 10, 3)).toContain(":10-12");
	});

	it("escapes offset and limit before they enter the line-number span", () => {
		const pathDisplay = load("pathDisplay") as (filePath: string, offset?: unknown, limit?: unknown) => string;
		const html = pathDisplay("src/app.ts", "<img src=x onerror=alert(1)>", 1);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("escapes an LSP line argument", () => {
		const renderLsp = load("renderLsp") as (name: string, args: Record<string, unknown>) => string;
		const html = renderLsp("lsp", { action: "definition", line: "1</span><img src=x onerror=alert(1)>" });
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("ships the escaped renderers in the generated export template", () => {
		const generated = readFileSync(new URL("../../src/export/html/template.generated.ts", import.meta.url), "utf8");
		expect(generated).toContain("escapeHtml(String(start))");
		expect(generated).toContain("escapeHtml(String(args.line))");
		expect(generated).toContain("rawStatus === 'completed'");
	});

	it("keeps a known todo status class and drops a status that breaks the attribute", () => {
		const renderTodoWrite = load("renderTodoWrite") as (
			name: string,
			args: Record<string, unknown>,
			result: { details: { phases: Array<{ name: string; tasks: Array<{ status: string; content: string }> }> } },
		) => string;
		const safe = renderTodoWrite(
			"todo_write",
			{},
			{ details: { phases: [{ name: "A", tasks: [{ status: "completed", content: "ship" }] }] } },
		);
		expect(safe).toContain('class="todo-task todo-completed"');
		const hostile = renderTodoWrite(
			"todo_write",
			{},
			{
				details: {
					phases: [{ name: "A", tasks: [{ status: 'pending"><img src=x onerror=alert(1)>', content: "ship" }] }],
				},
			},
		);
		expect(hostile).not.toContain("<img");
		expect(hostile).toContain('class="todo-task todo-pending"');
	});
});
