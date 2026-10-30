import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/Markdown";
import { closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

function render(text: string): string {
	return renderToStaticMarkup(<Markdown text={text} />);
}

describe("desktop Markdown", () => {
	test("renders common and GFM structures as semantic nodes", () => {
		const html = render("# Heading\n\nA **bold**, *em*, ~~gone~~ and `code`.  \nNext\n\n> quoted\n\n- [x] done\n- [ ] pending\n\n3. first\n4. second\n\n| A | B |\n| :- | -: |\n| x | y |\n\n---\n\n    indented");
		for (const fragment of ["<h1>Heading</h1>", "<strong>bold</strong>", "<em>em</em>", "<del>gone</del>", "<code>code</code>", "<br/>", "<blockquote>", "type=\"checkbox\"", "checked=\"\"", "<ol start=\"3\">", "<table>", "<th", "<td", "<hr/>", "indented"]) expect(html).toContain(fragment);
	});

	test("escapes raw HTML, blocks unsafe links and never renders markdown images", () => {
		const html = render('<script>alert(1)</script>\n\n<img src="https://evil.test/pixel">\n\n[bad](javascript:alert(1)) [protocol](//evil.test) [data](data:text/html,x) [safe](https://example.com) [mail](mailto:a@example.com) [anchor](#part) ![private](https://evil.test/pixel.png)');
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).not.toContain('href="javascript:');
		expect(html).not.toContain('href="//');
		expect(html).not.toContain('href="data:');
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('href="mailto:a@example.com"');
		expect(html).toContain('href="#part"');
		expect(html).toContain("private");
	});

	test("decodes Markdown entities once without interpreting them as HTML", () => {
		const html = render("A &amp; B &#65; &#x1F600; &copy; &lt;script&gt; &amp;lt; `&amp; <tag>` \\&amp;");
		expect(html).toContain("A &amp; B A 😀 © &lt;script&gt; &amp;lt;");
		expect(html).toContain("<code>&amp;amp; &lt;tag&gt;</code>");
		expect(html).toContain("&amp;amp;");
		expect(html).not.toContain("<script>");
	});

	test("keeps incomplete streamed markdown visible and safe", () => {
		for (const text of ["unfinished **strong", "[partial](https://", "```ts\nconst x = 1", "<script"]) {
			const html = render(text);
			expect(html).not.toContain("<script");
			expect(html).toContain(text.startsWith("```") ? "const x = 1" : text.startsWith("<") ? "&lt;script" : text.startsWith("[") ? "partial" : "unfinished");
		}
	});
});

describe("desktop Markdown clipboard", () => {
	const port = 16000 + Math.floor(Math.random() * 20000);
	const origin = `http://127.0.0.1:${port}`;
	let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
	let browser: Browser;

	beforeAll(async () => {
		server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
			cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
		});
		for (let i = 0; i < 100; i++) {
			try { if ((await fetch(origin)).ok) break; } catch { /* server is starting */ }
			await Bun.sleep(100);
		}
		browser = await puppeteer.launch({ executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	}, 30000);

	afterAll(async () => {
		await browser?.close();
		if (server) { server.kill(); await server.exited; }
	});

	test("copies exactly rendered code and reports success and failure", async () => {
		const { context, page } = await componentFixture(browser, origin);
		try {
			const initial = '  ```ts\r\n    const x = "<tag>";\r\n  \r\n  ```';
			const updated = '  ```ts\r\n    const x = 2;\r\n  ```';
			await componentReady(page, async () => {
			await page.setContent(`<div id="markdown-clipboard-fixture"></div><script type="module">
				import '/src/styles.css';
				import React from '${origin}/node_modules/.vite/deps/react.js';
				import ReactDOM from '${origin}/node_modules/.vite/deps/react-dom_client.js';
				const { createRoot } = ReactDOM;
				import { Markdown } from '${origin}/src/Markdown.tsx';
				const container = document.getElementById('markdown-clipboard-fixture');
				const root = createRoot(container);
				const render = text => root.render(React.createElement(Markdown, { text }));
				container.addEventListener('markdown-update', event => render(event.detail));
				render(${JSON.stringify(initial)});
				container.dataset.fixtureReady = 'yes';
			</script>`);
			await page.waitForSelector('#markdown-clipboard-fixture[data-fixture-ready="yes"] .markdown-code-copy');
			});
			await page.evaluate(() => {
				Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } });
			});
			await page.click("#markdown-clipboard-fixture .markdown-code-copy");
			await page.waitForFunction(() => document.querySelector('#markdown-clipboard-fixture [role="status"]')?.textContent === "복사됨");
			expect(await page.evaluate(() => document.body.dataset.copied)).toBe('  const x = "<tag>";\n');
			expect(await page.evaluate(() => document.body.dataset.copied)).toBe(await page.$eval('#markdown-clipboard-fixture pre code', element => element.textContent));
			await page.evaluate(text => {
				document.querySelector('#markdown-clipboard-fixture')?.dispatchEvent(new CustomEvent('markdown-update', { detail: text }));
			}, updated);
			await page.waitForFunction(() => document.querySelector('#markdown-clipboard-fixture pre')?.textContent?.includes('const x = 2'));
			expect(await page.$eval('#markdown-clipboard-fixture [role="status"]', node => node.textContent)).toBe('');
			await page.evaluate(() => {
				Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
			});
			await page.click("#markdown-clipboard-fixture .markdown-code-copy");
			await page.waitForFunction(() => document.querySelector('#markdown-clipboard-fixture [role="status"]')?.textContent === "복사 실패");
			await page.evaluate(text => {
				document.querySelector('#markdown-clipboard-fixture')?.dispatchEvent(new CustomEvent('markdown-update', { detail: text }));
			}, initial);
			await page.waitForFunction(() => document.querySelector('#markdown-clipboard-fixture pre')?.textContent?.includes('const x = "<tag>"'));
			expect(await page.$eval('#markdown-clipboard-fixture [role="status"]', node => node.textContent)).toBe('');
			await page.evaluate(() => {
				Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } });
			});
			for (const { source, expected } of [
				{ source: '> ```ts\r\n> const quote = 1;\r\n> ```', expected: 'const quote = 1;' },
				{ source: '- item\r\n\r\n  ```ts\r\n  const list = 2;\r\n  ```', expected: 'const list = 2;' },
				{ source: '    const indent = 3;\r\n    next();', expected: 'const indent = 3;\nnext();' },
			]) {
				await page.evaluate(text => document.querySelector('#markdown-clipboard-fixture')?.dispatchEvent(new CustomEvent('markdown-update', { detail: text })), source);
				await page.waitForFunction(text => document.querySelector('#markdown-clipboard-fixture pre code')?.textContent === text, {}, expected);
				await page.click('#markdown-clipboard-fixture .markdown-code-copy');
				await page.waitForFunction(text => document.body.dataset.copied === text, {}, expected);
				expect(await page.evaluate(() => document.body.dataset.copied)).toBe(expected);
			}
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);
});
