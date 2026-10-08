import { describe, expect, it } from "bun:test";
import type { MarkdownTheme, SvgFigureResolveContext } from "../src/components/markdown";
import { clearRenderCache, Markdown } from "../src/components/markdown";
import type { Component } from "../src/tui";
import { defaultMarkdownTheme } from "./test-themes";

class DeferredFigure implements Component {
	#onChange: () => void;
	source: string;
	ready = false;
	disposed = false;

	constructor(source: string, onChange: () => void) {
		this.source = source;
		this.#onChange = onChange;
	}

	update(source: string, onChange: () => void): void {
		this.source = source;
		this.#onChange = onChange;
	}

	render(_width: number): string[] {
		return this.ready ? ["<svg raster>"] : [];
	}

	invalidate(): void {}

	complete(): void {
		this.ready = true;
		this.#onChange();
	}

	dispose(): void {
		this.disposed = true;
	}
}

function figureTheme(figures: DeferredFigure[], onResolve?: (context: SvgFigureResolveContext) => void): MarkdownTheme {
	return {
		...defaultMarkdownTheme,
		resolveSvgFigure: (source, context) => {
			onResolve?.(context);
			const figure =
				context.previous instanceof DeferredFigure
					? context.previous
					: new DeferredFigure(source, context.onChange);
			figure.update(source, context.onChange);
			if (!figures.includes(figure)) figures.push(figure);
			return figure;
		},
	};
}

describe("Markdown asynchronous SVG figures", () => {
	it("caches stable SVG declines per instance without sharing them across instances", () => {
		clearRenderCache();
		const source = "```svg\n<svg/>\n```";
		let resolverCalls = 0;
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			resolveSvgFigure: () => {
				resolverCalls++;
				return null;
			},
		};
		const first = new Markdown(source, 0, 0, theme);
		const firstRender = first.render(80);

		expect(first.render(80)).toBe(firstRender);
		expect(resolverCalls).toBe(1);
		expect(Bun.stripANSI(firstRender.join("\n"))).toContain("<svg/>");

		const second = new Markdown(source, 0, 0, theme);
		second.render(80);
		expect(resolverCalls).toBe(2);
		first.dispose();
		second.dispose();
	});

	it("retries SVG fences when the resolver returns undefined", () => {
		const source = "```svg\n<svg/>\n```";
		let resolverCalls = 0;
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			resolveSvgFigure: () => {
				resolverCalls++;
				return undefined;
			},
		};
		const markdown = new Markdown(source, 0, 0, theme);
		markdown.render(80);
		markdown.render(80);
		expect(resolverCalls).toBe(2);
		markdown.dispose();
	});

	it("rerenders pending figures after completion and keeps them out of both render caches", () => {
		const source = "Intro\n\n~~~ SVG title\n<SVG/>\n~~~\n\nOutro";
		const figures: DeferredFigure[] = [];
		let resolverCalls = 0;
		const theme = figureTheme(figures, () => resolverCalls++);
		let repaints = 0;
		const first = new Markdown(source, 0, 0, theme);
		first.setOnStaleThrottle(() => repaints++);

		const pending = first.render(80).join("\n");
		expect(pending).toContain("Intro");
		expect(pending).toContain("Outro");
		expect(pending).not.toContain("<svg raster>");
		expect(resolverCalls).toBe(1);

		const firstFigure = figures[0];
		if (!firstFigure) throw new Error("Expected the resolver to create a figure");
		firstFigure.complete();
		expect(repaints).toBe(1);
		expect(first.render(80).join("\n")).toContain("<svg raster>");
		expect(resolverCalls).toBe(2);

		const second = new Markdown(source, 0, 0, theme);
		second.render(80);
		const secondFigure = figures[1];
		if (!secondFigure) throw new Error("Expected a distinct Markdown instance to own its figure");
		secondFigure.complete();
		expect(second.render(80).join("\n")).toContain("<svg raster>");

		first.dispose();
		second.dispose();
		expect(firstFigure.disposed).toBe(true);
		expect(secondFigure.disposed).toBe(true);
	});

	it("leaves SVG fences nested in blockquotes on the ordinary code path", () => {
		const figures: DeferredFigure[] = [];
		let resolverCalls = 0;
		const markdown = new Markdown(
			"> ```svg\n> <svg/>\n> ```",
			0,
			0,
			figureTheme(figures, () => resolverCalls++),
		);

		const rendered = Bun.stripANSI(markdown.render(80).join("\n"));
		expect(resolverCalls).toBe(0);
		expect(rendered).toContain("```svg");
		expect(rendered).toContain("<svg/>");
		markdown.dispose();
	});

	it("keeps render caching enabled for SVG examples nested inside another fence", () => {
		clearRenderCache();
		const figures: DeferredFigure[] = [];
		let resolverCalls = 0;
		let codeBlockCalls = 0;
		const baseTheme = figureTheme(figures, () => resolverCalls++);
		const theme = {
			...baseTheme,
			codeBlock: (text: string) => {
				codeBlockCalls++;
				return defaultMarkdownTheme.codeBlock(text);
			},
		};
		const source = "````markdown\n```svg\n<svg/>\n```\n````";
		const first = new Markdown(source, 0, 0, theme);
		first.render(80);
		const renderedCodeBlockCalls = codeBlockCalls;

		const second = new Markdown(source, 0, 0, theme);
		second.render(80);

		expect(resolverCalls).toBe(0);
		expect(renderedCodeBlockCalls).toBeGreaterThan(0);
		expect(codeBlockCalls).toBe(renderedCodeBlockCalls);
		first.dispose();
		second.dispose();
	});

	it("keeps list-contained SVG examples on the ordinary cached code path", () => {
		clearRenderCache();
		const figures: DeferredFigure[] = [];
		let resolverCalls = 0;
		let codeBlockCalls = 0;
		const baseTheme = figureTheme(figures, () => resolverCalls++);
		const theme = {
			...baseTheme,
			codeBlock: (text: string) => {
				codeBlockCalls++;
				return defaultMarkdownTheme.codeBlock(text);
			},
		};
		const source = "- example\n  ```svg\n  <svg/>\n  ```";
		const first = new Markdown(source, 0, 0, theme);
		first.render(80);
		expect(resolverCalls).toBe(0);
		expect(codeBlockCalls).toBe(1);

		const second = new Markdown(source, 0, 0, theme);
		second.render(80);
		expect(resolverCalls).toBe(0);
		expect(codeBlockCalls).toBe(1);
		first.dispose();
		second.dispose();
	});
});
