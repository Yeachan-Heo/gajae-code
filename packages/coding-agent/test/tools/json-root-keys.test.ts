import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme as liveTheme } from "../../src/modes/theme/theme";
import { renderMCPCall, renderMCPResult } from "../../src/runtime-mcp/render";
import { formatArgsInline, renderJsonTreeLines } from "../../src/tools/json-tree";

beforeAll(async () => {
	await initTheme(false, "unicode");
});

function renderRootTree(args: Record<string, unknown>): string {
	return renderJsonTreeLines(args, liveTheme, 6, 20, 60)
		.lines.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("own JSON argument keys", () => {
	for (const key of ["constructor", "toString", "__proto__"]) {
		it(`keeps ${key} in inline arguments`, () => {
			const args = JSON.parse(`{"${key}":1,"normal":2}`);
			expect(formatArgsInline(args, 200)).toContain(`${key}=1`);
			expect(formatArgsInline(args, 200)).toContain("normal=2");
		});
		it(`keeps ${key} in root tree arguments`, () => {
			const args = JSON.parse(`{"${key}":1,"normal":2}`);
			expect(renderRootTree(args)).toContain(`${key}: 1`);
		});
	}
	it("still hides only reserved root argument metadata", () => {
		const args = { _i: "intent", __partialJson: true, normal: 2 };
		expect(formatArgsInline(args, 200)).toBe("normal=2");
		const output = renderRootTree(args);
		expect(output).toContain("normal: 2");
		expect(output).not.toContain("_i:");
		expect(output).not.toContain("__partialJson:");
	});
	it("keeps ordinary and nested object keys", () => {
		const args = JSON.parse('{"nested":{"constructor":1,"toString":2,"__proto__":3}}');
		const out = renderRootTree(args);
		for (const key of ["constructor", "toString", "__proto__"]) expect(out).toContain(`${key}:`);
	});
});

for (const key of ["constructor", "toString", "__proto__"]) {
	it(`shows ${key} through the real MCP call and expanded result components`, () => {
		const args = JSON.parse(`{"${key}":1,"_i":"intent","__partialJson":true}`);
		const preview = renderMCPCall(args, liveTheme, "MCP example")
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		const expanded = renderMCPResult(
			{ content: [{ type: "text", text: "complete" }] },
			{ expanded: true, isPartial: false },
			liveTheme,
			args,
		)
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(preview).toContain(`${key}=1`);
		expect(expanded).toContain(`${key}: 1`);
		expect(expanded).not.toContain("_i:");
		expect(expanded).not.toContain("__partialJson:");
	});
}
