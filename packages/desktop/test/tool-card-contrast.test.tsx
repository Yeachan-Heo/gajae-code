import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import puppeteer, { type Browser } from "puppeteer-core";
import { THEME_IDS } from "../src/themes";
import { browserPath, closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

const suite = browserPath ? describe : describe.skip;
const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	if (!browserPath) return;
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {
			/* The server is starting. */
		}
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => {
	await browser?.close();
	if (server) {
		server.kill();
		await server.exited;
	}
});

const call = (id: string, status: DesktopToolCall["status"], extra: Partial<DesktopMessage> = {}): DesktopMessage => ({
	id,
	role: "tool",
	toolName: "bash",
	text: "output",
	...extra,
	tool: { callId: id, status, family: "shell", subject: `$ step ${id}`, detail: true },
});

/** The tool-card text WCAG AA asks 4.5:1 of, each against what is actually painted behind it. */
const TARGETS = {
	failedStatus: ".tool-call-status.tool-failure",
	cancelledStatus: ".tool-call-status.tool-call-cancelled",
	groupFailed: ".tool-group-failed",
	diffError: ".tool-diff-error",
	detailError: ".tool-detail-error .error-content",
	addedNumber: ".tool-diff-add .tool-diff-number",
	removedNumber: ".tool-diff-remove .tool-diff-number",
	hunkLine: ".tool-diff-hunk",
	addedLine: ".tool-diff-add",
	removedLine: ".tool-diff-remove",
	detailTruncated: ".tool-call-details > .truncation-notice",
	cardTruncated: ".tool-call > .truncation-notice",
	addedFact: ".tool-fact-added",
	removedFact: ".tool-fact-removed",
} as const;

suite("tool card contrast", () => {
	test("status, error, diff and notice text reach 4.5:1 in every bundled theme", async () => {
		const { context, page } = await componentFixture(browser, origin);
		try {
			await componentReady(page, async () => {
				await page.addScriptTag({
					type: "module",
					content: `
						import React from '/node_modules/.vite/deps/react.js';
						import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
						import { Message } from '/src/components.tsx';
						import { ToolCallDetails } from '/src/ToolCallCard.tsx';
						import { groupTranscript, ToolRun } from '/src/transcript-groups.tsx';
						import { applyTheme } from '/src/themes.ts';
						const h = React.createElement;
						const failed = ${JSON.stringify(call("f", "failed", { isError: true, truncated: true }))};
						const cancelled = ${JSON.stringify(call("c", "cancelled", { isError: true }))};
						const group = groupTranscript([${JSON.stringify(call("a", "done"))}, ${JSON.stringify(call("b", "failed", { isError: true }))}], 10)[0];
						const ready = { kind: 'ready', detail: { callId: 'd', truncated: true, diff: [
							{ path: 'src/a.ts', diff: '@@ -1 +1 @@\\n-1|old\\n+1|new', added: 1, removed: 1 },
							{ path: 'src/b.ts', diff: '', added: 0, removed: 0, error: 'No match in src/b.ts' },
						] } };
						function Fixture() {
							return h('div', { className: 'conversation' },
								h(Message, { message: failed }),
								h(Message, { message: cancelled }),
								h(ToolRun, { item: group, renderMessage: message => h(Message, { message }) }),
								h('article', { className: 'message tool tool-call' }, h('div', { className: 'tool-call-details' },
									h(ToolCallDetails, { family: 'edit', state: ready }),
									h(ToolCallDetails, { family: 'edit', state: { kind: 'error', message: 'This tool call is no longer available.' } }),
									h('span', { className: 'tool-call-facts' }, h('span', { className: 'tool-fact-added' }, '+1'), ' ', h('span', { className: 'tool-fact-removed' }, '−1')))));
						}
						window.applyTheme = applyTheme;
						const root = document.createElement('div');
						document.body.replaceChildren(root);
						ReactDOM.createRoot(root).render(h(Fixture));
					`,
				});
				await page.waitForSelector(".tool-diff-error");
			});
			await page.addStyleTag({ url: `${origin}/src/styles.css` });
			// Colors transition on theme changes; measure settled values.
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			const ratios: Record<string, Record<string, number>> = {};
			for (const theme of THEME_IDS) {
				ratios[theme] = await page.evaluate(
					(theme, targets) => {
						(window as unknown as { applyTheme(id: string): void }).applyTheme(theme);
						const canvas = document.createElement("canvas");
						canvas.width = canvas.height = 1;
						const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
						/** Any CSS color (including color-mix results) as sRGB bytes and alpha, through a canvas. */
						const rgba = (color: string): [number, number, number, number] => {
							ctx.clearRect(0, 0, 1, 1);
							ctx.fillStyle = "#000";
							ctx.fillStyle = color;
							ctx.fillRect(0, 0, 1, 1);
							const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
							// ImageData holds straight (not premultiplied) alpha.
							return [r!, g!, b!, a! / 255];
						};
						const over = (top: number[], bottom: number[]) =>
							[0, 1, 2].map(i => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!));
						/** The opaque color behind `node`: every ancestor's background, composited from the root. */
						const behind = (node: Element): number[] => {
							const chain: Element[] = [];
							for (let at: Element | null = node; at; at = at.parentElement) chain.unshift(at);
							let painted = rgba(getComputedStyle(document.documentElement).getPropertyValue("--bg")).slice(0, 3);
							for (const at of chain) {
								const layer = rgba(getComputedStyle(at).backgroundColor);
								if (layer[3]) painted = over(layer, painted);
							}
							return painted;
						};
						const luminance = (rgb: number[]) => {
							const [r, g, b] = rgb.map(value => {
								const c = value / 255;
								return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
							});
							return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
						};
						const result: Record<string, number> = {};
						for (const [name, selector] of Object.entries(targets)) {
							const node = document.querySelector(selector);
							if (!node) {
								result[name] = -1;
								continue;
							}
							const back = behind(node);
							const text = over(rgba(getComputedStyle(node).color), back);
							const [light, dark] = [luminance(text), luminance(back)].sort((x, y) => y - x);
							result[name] = Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
						}
						return result;
					},
					theme,
					TARGETS,
				);
			}
			const below = Object.entries(ratios).flatMap(([theme, values]) =>
				Object.entries(values)
					.filter(([, ratio]) => ratio < 4.5)
					.map(([name, ratio]) => `${theme} ${name} ${ratio}`),
			);
			expect(below).toEqual([]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 60000);
});
