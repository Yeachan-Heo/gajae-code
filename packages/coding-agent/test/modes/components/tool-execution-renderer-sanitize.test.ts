import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";

async function paintedLine(line: string): Promise<string> {
	const mod = await import("@gajae-code/coding-agent/modes/components/tool-execution");
	const sanitize = mod.sanitizePaintedToolLine as ((value: string) => string) | undefined;
	if (!sanitize) throw new Error("painted line filter is missing");
	return sanitize(line);
}

import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import {
	Box,
	Container,
	extractCopyRowAnnotation,
	Image,
	ImageProtocol,
	Markdown,
	retainCopyAnnotations,
	setKittyTransmitWriter,
	setTerminalImageProtocol,
	TERMINAL,
	Text,
	type TUI,
} from "@gajae-code/tui";
import { writeTerminalOutput } from "@gajae-code/tui/terminal-writer";
import fc from "fast-check";

const SEED = 67821;
const uiStub = { requestRender() {} } as unknown as TUI;
const ERASE = "\u001b[2J";
const OSC_TITLE = "\u001b]0;prop\u0007";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

afterEach(() => {
	resetSettingsForTest();
});

function renderFind(files: string[], isPartial = false): string {
	const details = { fileCount: files.length, files };
	const component = new ToolExecutionComponent("find", { paths: ["notes/**"] }, {}, undefined, uiStub, process.cwd());
	component.updateResult({ content: [{ type: "text", text: files.join("\n") }], details }, isPartial);
	expect(details.files).toEqual(files);
	return component.render(120).join("\n");
}

function safePiece(): fc.Arbitrary<string> {
	return fc
		.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._-[]".split("")), {
			minLength: 1,
			maxLength: 12,
		})
		.map(chars => chars.join(""));
}

describe("painted tool cards", () => {
	it("does not draw a raw erase sequence from a find path", () => {
		const attack = `notes/${ERASE}plan.ts`;
		for (const partial of [false, true]) {
			const raw = renderFind([attack], partial);
			expect(raw).not.toContain(ERASE);
			expect(raw).toContain("notes/plan.ts");
		}
	});

	it("still draws ordinary find paths, including a lookalike and a Windows path", () => {
		const lookalike = "notes/[2J] plan.ts";
		const windowsPath = "C:\\work\\plan.ts";
		const mixedCase = "Notes/Plan.TS";
		const raw = renderFind([lookalike, windowsPath, mixedCase, "notes/plan.ts "]);
		expect(raw).toContain(lookalike);
		expect(raw).toContain(windowsPath);
		expect(raw).toContain(mixedCase);
		expect(raw).toContain("notes/plan.ts");
	});

	it("strips a custom renderer card without using the text fallback", () => {
		const tool = {
			label: "Custom",
			renderResult() {
				return new Text(`alpha${ERASE}beta`, 0, 0);
			},
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const raw = component.render(80).join("\n");
		expect(raw).toContain("alphabeta");
		expect(raw).not.toContain(ERASE);
		expect(raw).not.toContain("fallback-marker");
	});

	it("keeps the delete operation when one guarded path collides after control removal", () => {
		const deletePath = `notes/${ERASE}plan.ts`;
		const input = [
			"*** Begin Patch",
			`*** Delete File: ${deletePath}`,
			"*** Add File: notes/plan.ts",
			"+hello",
			"*** End Patch",
		].join("\n");
		for (const isPartial of [false, true]) {
			const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub, process.cwd());
			component.updateResult(
				{
					content: [{ type: "text", text: "refused" }],
					details: {
						perFileResults: [{ path: deletePath, diff: "", isError: true, errorText: "guard refused" }],
					},
					isError: true,
				},
				isPartial,
			);
			const raw = component.render(160).join("\n");
			const plain = Bun.stripANSI(raw);
			expect(plain).toContain("Delete");
			expect(plain).not.toContain("Create");
			expect(plain).toContain("guard refused");
			expect(raw).not.toContain(ERASE);
		}
	});
});

describe("sanitizePaintedToolLine", () => {
	it("preserves SGR color and file hyperlinks", async () => {
		const colored = "\u001b[31mnotes\u001b[39m";
		const link = "\u001b]8;id=0123abcd;file:///proj/notes.ts\u001b\\notes.ts\u001b]8;;\u001b\\";
		expect(await paintedLine(colored)).toBe(colored);
		expect(await paintedLine(link)).toBe(link);
		expect(await paintedLine(`a${ERASE}b`)).toBe("ab");
		expect(await paintedLine(`a${OSC_TITLE}b`)).toBe("ab");
		expect(await paintedLine("a\u0000b\tb")).toBe("ab\tb");
		const evil = "\u001b]8;;https://attacker.invalid/\u001b\\link\u001b]8;;\u001b\\";
		const cleaned = await paintedLine(evil);
		expect(cleaned).toContain("link");
		expect(cleaned).not.toContain("attacker.invalid");
		const bel = "\u001b]8;;file:///proj/notes.ts\u0007notes.ts\u001b]8;;\u0007";
		expect(await paintedLine(bel)).toBe(bel);
		expect(await paintedLine("\u001b[2A\u001b_Ga=p,i=1\u001b\\")).toBe("");
		expect(await paintedLine("\u001b[99A\u001b_AGJC_COPYfake\u001b\\")).toBe("");
		expect(await paintedLine("\u001b]1337;File=abcd\u0007")).toBe("");
	});

	it("property: painted line idempotence, fc.property seed 67821, numRuns 64", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ unit: "binary", maxLength: 48 }), async text => {
				const once = await paintedLine(text);
				expect(await paintedLine(once)).toBe(once);
				expect(once.length).toBeLessThanOrEqual(text.length);
				expect(once.includes("\u0000")).toBe(false);
				expect(once.includes(ERASE)).toBe(false);
				expect(once.includes("\u001b]0;")).toBe(false);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});

	it("property: ordinary find text stays visible, fc.property seed 67821, numRuns 64", () => {
		fc.assert(
			fc.property(safePiece(), text => {
				const raw = renderFind([`notes/${text}.ts`, `\t${text}`]);
				expect(raw).toContain(`notes/${text}.ts`);
				expect(raw).toContain(text);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});

	it("property: nested result controls, fc.property seed 67821, numRuns 64", () => {
		fc.assert(
			fc.property(
				safePiece(),
				fc.constantFrom(ERASE, "\u0000", "\u0007", OSC_TITLE),
				safePiece(),
				(left, ctrl, right) => {
					const label = `L${left}${ctrl}${right}R`;
					const visible = `L${left}${right}R`;
					const files = [`notes/${label}.ts`];
					const findRaw = renderFind(files);
					expect(findRaw).not.toContain(ctrl);
					expect(findRaw).toContain(`notes/${visible}.ts`);
					const details = {
						jobs: [
							{
								id: "job-1",
								type: "task" as const,
								status: "completed" as const,
								label,
								durationMs: 5,
								errorText: label,
							},
						],
					};
					const job = new ToolExecutionComponent("job", {}, {}, undefined, uiStub, process.cwd());
					job.updateResult({ content: [{ type: "text", text: "ignored" }], details }, false);
					const jobRaw = job.render(160).join("\n");
					expect(jobRaw).not.toContain(ctrl);
					expect(jobRaw).toContain(visible);
					expect(details.jobs[0]?.label).toBe(label);
					expect(details.jobs[0]?.errorText).toBe(label);
					expect(files[0]).toBe(`notes/${label}.ts`);
				},
			),
			{ seed: SEED, numRuns: 64 },
		);
	});

	it("property: file BEL links stay and forged graphics do not, fc.property seed 67821, numRuns 64", async () => {
		const pieceArb = fc.stringMatching(/^[A-Za-z0-9._~-]{1,12}$/u);
		await fc.assert(
			fc.asyncProperty(pieceArb, async piece => {
				const link = `\u001b]8;;file:///proj/${piece}.ts\u0007${piece}\u001b]8;;\u0007`;
				expect(await paintedLine(link)).toBe(link);
				expect(await paintedLine(`notes/[2A]${piece}`)).toBe(`notes/[2A]${piece}`);
				const path = `notes/\u001b[2A\u001b_Ga=p,${piece}\u001b\\${piece}.ts`;
				const raw = renderFind([path]);
				expect(raw).not.toContain("\u001b[2A");
				expect(raw).not.toContain("\u001b_G");
				expect(raw).toContain("notes/");
				expect(raw).toContain(`${piece}.ts`);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const terminalState = TERMINAL as unknown as { hyperlinks: boolean; imageProtocol: ImageProtocol | null };

describe("trusted renderer components", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalHyperlinks = terminalState.hyperlinks;
	const originalForce = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllow = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const originalGjcForce = Bun.env.GJC_FORCE_IMAGE_PROTOCOL;
	const originalGjcAllow = Bun.env.GJC_ALLOW_SIXEL_PASSTHROUGH;

	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalState.hyperlinks = originalHyperlinks;
		setKittyTransmitWriter(writeTerminalOutput);
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForce);
		restoreEnv("PI_ALLOW_SIXEL_PASSTHROUGH", originalAllow);
		restoreEnv("GJC_FORCE_IMAGE_PROTOCOL", originalGjcForce);
		restoreEnv("GJC_ALLOW_SIXEL_PASSTHROUGH", originalGjcAllow);
	});

	it("paints a custom Image on Kitty and iTerm2", () => {
		const tool = {
			label: "Img",
			renderResult() {
				return new Image(
					PNG,
					"image/png",
					{ fallbackColor: text => text },
					{ refetch: () => PNG },
					{ widthPx: 40, heightPx: 80 },
				);
			},
		} as unknown as AgentTool;
		const paint = (protocol: ImageProtocol) => {
			setTerminalImageProtocol(protocol);
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			return component.render(80).join("\n");
		};
		setKittyTransmitWriter(() => {});
		const kitty = paint(ImageProtocol.Kitty);
		expect(kitty).toContain("\u001b_Ga=p");
		expect(kitty).not.toContain(ERASE);
		const iterm = paint(ImageProtocol.Iterm2);
		expect(iterm).toContain("\u001b]1337;File=");
		expect(iterm).toMatch(/\u001b\[\d+A/);
	});

	it("paints a Markdown file link and its copy annotation inside a container", () => {
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			const tool = {
				label: "Ask",
				renderCall() {
					const box = new Container();
					box.addChild(new Markdown("[plan](notes/plan.ts)", 0, 0, themeModule.getMarkdownTheme()));
					return box;
				},
			} as unknown as AgentTool;
			const component = new ToolExecutionComponent("ask", { question: "plan" }, {}, tool, uiStub, process.cwd());
			const raw = component.render(80).join("\n");
			expect(raw).toContain("plan");
			expect(raw).toContain("\u001b]8;;");
			expect(raw).toContain("file://");
			expect(raw).toContain("\u0007");
			expect(raw).toContain("\u001b_AGJC_COPY");
			expect(raw.split("\n").some(line => extractCopyRowAnnotation(line) !== null)).toBe(true);
		} finally {
			release();
		}
	});

	it("keeps bash SIXEL passthrough and strips the same bytes from a find path", () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		Bun.env.GJC_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.GJC_ALLOW_SIXEL_PASSTHROUGH = "1";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const payload = "#0!10~-payload";
		const bash = new ToolExecutionComponent("bash", { command: "img" }, {}, undefined, uiStub, process.cwd());
		bash.updateResult(
			{ content: [{ type: "text", text: `visible\n\u001bPq\n${payload}\n\u001b\\\nafter` }], details: {} },
			false,
		);
		const kept = bash.render(100).join("\n");
		expect(kept).toContain(payload);
		expect(kept).toContain("\u001bPq");
		expect(kept).toContain("\u001b\\");
		expect(kept).toContain("after");
		expect(kept).toContain("visible");
		const closed = new ToolExecutionComponent("bash", { command: "img" }, {}, undefined, uiStub, process.cwd());
		closed.updateResult(
			{ content: [{ type: "text", text: "\u001bPq~\u001b\\\u001bPqUNFINISHED_PAYLOAD" }], details: {} },
			false,
		);
		expect(closed.render(100).join("\n")).not.toContain("UNFINISHED_PAYLOAD");
		const c1 = new ToolExecutionComponent("bash", { command: "img" }, {}, undefined, uiStub, process.cwd());
		c1.updateResult({ content: [{ type: "text", text: "\u001bPq\n#0!10~-\u009b\n\u001b\\" }], details: {} }, false);
		const c1Raw = c1.render(100).join("\n");
		expect(c1Raw).not.toContain("#0!10~-");
		expect(c1Raw).not.toContain("\u009b");
		const open = new ToolExecutionComponent("bash", { command: "img" }, {}, undefined, uiStub, process.cwd());
		open.updateResult(
			{ content: [{ type: "text", text: "visible\u001bPq\n#0!10~-payload\ntail-after-open" }], details: {} },
			false,
		);
		const hidden = open.render(100).join("\n");
		expect(hidden).toContain("visible");
		expect(hidden).not.toContain("#0!10~-payload");
		expect(hidden).not.toContain("tail-after-open");
		const forged = "\u001b[2A\u001b_Ga=p,i=1\u001b\\\u001b]1337;File=abcd\u0007\u001b_AGJC_COPYfake\u001b\\";
		const findRaw = renderFind([`notes/${forged}plan.ts`]);
		expect(findRaw).not.toContain("\u001b[2A");
		expect(findRaw).not.toContain("\u001b_G");
		expect(findRaw).not.toContain("1337");
		expect(findRaw).not.toContain("AGJC_COPY");
		expect(findRaw).toContain("notes/");
		expect(findRaw).toContain("plan.ts");
		const text = new ToolExecutionComponent("bash", { command: "echo" }, {}, undefined, uiStub, process.cwd());
		text.updateResult({ content: [{ type: "text", text: `before${forged}after` }], details: {} }, false);
		const textRaw = text.render(120).join("\n");
		expect(textRaw).toContain("before");
		expect(textRaw).toContain("after");
		expect(textRaw).not.toContain("\u001b_G");
		expect(textRaw).not.toContain("1337");
		expect(textRaw).not.toContain("AGJC_COPY");
	});

	it("drops a multiline SIXEL block when passthrough is off", () => {
		setTerminalImageProtocol(null);
		delete Bun.env.GJC_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.GJC_ALLOW_SIXEL_PASSTHROUGH;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		const bash = new ToolExecutionComponent("bash", { command: "img" }, {}, undefined, uiStub, process.cwd());
		bash.updateResult(
			{ content: [{ type: "text", text: "visible\u001bPq\n#0!10~-payload\n\u001b\\" }], details: {} },
			false,
		);
		const raw = bash.render(100).join("\n");
		expect(raw).toContain("visible");
		expect(raw).not.toContain("#0!10~-payload");
		expect(raw).not.toContain("\u001bPq");
	});

	it("strips hostile single-line SIXEL and leaves a clean ST SIXEL", () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const paintText = (body: string) => {
			const tool = {
				label: "Txt",
				renderResult() {
					return new Text(body, 0, 0);
				},
			} as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			return component.render(120).join("\n");
		};
		for (const payload of ["\u0018\u009b2J", "\u001a", "\u0000"]) {
			const attack = `\u001bPq~${payload}\u001b\\`;
			const findRaw = renderFind([`notes/${attack}plan.ts`]);
			expect(findRaw).not.toContain(payload);
			expect(findRaw).toContain("notes/");
			expect(findRaw).toContain("plan.ts");
			const textRaw = paintText(`before${attack}after`);
			expect(textRaw).not.toContain(payload);
			expect(textRaw).toContain("before");
			expect(textRaw).toContain("after");
			expect(textRaw).not.toContain("fallback-marker");
		}
		const clean = "\u001bPq~-ok\u001b\\";
		// File paths are untrusted labels and sanitized by sanitizeFileLabel.
		// Clean SIXEL should be stripped from find paths even though it's not hostile.
		const findRawClean = renderFind([`notes/${clean}plan.ts`]);
		expect(findRawClean).not.toContain(clean);
		expect(findRawClean).toContain("notes/");
		expect(findRawClean).toContain("plan.ts");
		// Trusted renderResult content preserves clean SIXEL.
		expect(paintText(`before${clean}after`)).toContain(clean);
	});

	it("property: single-line SIXEL payload, fc.property seed 67821, numRuns 64", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const bodyArb = fc
			.array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 1, maxLength: 24 })
			.map(codes => String.fromCharCode(...codes));
		const badArb = fc.constantFrom(0x00, 0x18, 0x1a, 0x7f, 0x9b);
		await fc.assert(
			fc.asyncProperty(bodyArb, fc.integer({ min: 0, max: 24 }), badArb, async (body, at, bad) => {
				const cut = Math.min(at, body.length);
				const hostileBody = `${body.slice(0, cut)}${String.fromCharCode(bad)}${body.slice(cut)}`;
				const hostile = `\u001bPq${hostileBody}\u001b\\`;
				const cleaned = await paintedLine(hostile);
				expect(cleaned.includes(String.fromCharCode(bad))).toBe(false);
				expect(cleaned.includes("\u001bPq")).toBe(false);
				expect(await paintedLine(`\u001bPq${body}\u001b\\`)).toBe(`\u001bPq${body}\u001b\\`);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});

	it("filters text created during render, added later, or returned raw", () => {
		const card = (renderResult: () => Container | Box) => {
			const tool = { label: "Card", renderResult } as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			return component;
		};
		class LateText extends Container {
			render(width: number): string[] {
				this.clear();
				this.addChild(new Text(`left${ERASE}right`, 0, 0));
				return super.render(width);
			}
		}
		const lateRaw = card(() => new LateText())
			.render(80)
			.join("\n");
		expect(lateRaw).not.toContain(ERASE);
		expect(lateRaw).toContain("leftright");
		class LateBox extends Box {
			render(width: number): string[] {
				this.clear();
				this.addChild(new Text(`L${ERASE}R`, 0, 0));
				return super.render(width);
			}
		}
		const boxRaw = card(() => new LateBox())
			.render(80)
			.join("\n");
		expect(boxRaw).not.toContain(ERASE);
		expect(boxRaw).toContain("LR");
		const held = new Container();
		held.children.push(new Text(`push${ERASE}ed`, 0, 0));
		const pushed = card(() => held)
			.render(80)
			.join("\n");
		expect(pushed).not.toContain(ERASE);
		expect(pushed).toContain("pushed");
		const grow = new Container();
		const grown = card(() => grow);
		grown.render(80);
		grow.addChild(new Text(`pre${ERASE}post`, 0, 0));
		const grownRaw = grown.render(80).join("\n");
		expect(grownRaw).not.toContain(ERASE);
		expect(grownRaw).toContain("prepost");
		class RawErase extends Container {
			render(): string[] {
				return [`raw${ERASE}line`];
			}
		}
		const raw = card(() => new RawErase())
			.render(80)
			.join("\n");
		expect(raw).not.toContain(ERASE);
		expect(raw).toContain("rawline");
	});

	it("paints Image and Markdown inside a container that also returns raw text", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyTransmitWriter(() => {});
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			class LateTrust extends Container {
				render(width: number): string[] {
					this.clear();
					this.addChild(
						new Image(
							PNG,
							"image/png",
							{ fallbackColor: text => text },
							{ refetch: () => PNG },
							{ widthPx: 40, heightPx: 80 },
						),
					);
					this.addChild(new Markdown("[plan](notes/plan.ts)", 0, 0, themeModule.getMarkdownTheme()));
					return [...super.render(width), `forged${ERASE}tail`];
				}
			}
			const tool = { label: "Trust", renderResult: () => new LateTrust() } as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			const painted = component.render(100).join("\n");
			expect(painted).toContain("\u001b_Ga=p");
			expect(painted).toContain("\u001b]8;;");
			expect(painted).toContain("file://");
			expect(painted).toContain("\u001b_AGJC_COPY");
			expect(painted).not.toContain(ERASE);
			expect(painted).toContain("forgedtail");
			expect(painted.split("\n").some(line => extractCopyRowAnnotation(line) !== null)).toBe(true);
		} finally {
			release();
		}
	});

	it("paints delegated Image and Markdown and strips a sibling erase", () => {
		setKittyTransmitWriter(() => {});
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			const image = new Image(
				PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ refetch: () => PNG },
				{ widthPx: 40, heightPx: 80 },
			);
			const markdown = new Markdown("[plan](notes/plan.ts)", 0, 0, themeModule.getMarkdownTheme());
			const paint = (protocol: ImageProtocol) => {
				setTerminalImageProtocol(protocol);
				const tool = {
					label: "Deleg",
					renderResult() {
						return {
							render: (width: number) => [...image.render(width), ...markdown.render(width), `bad${ERASE}tail`],
							invalidate() {
								image.invalidate?.();
								markdown.invalidate?.();
							},
						};
					},
				} as unknown as AgentTool;
				const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
				component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
				return component.render(100).join("\n");
			};
			const kitty = paint(ImageProtocol.Kitty);
			expect(kitty).toContain("\u001b_Ga=p");
			expect(kitty).toContain("\u001b_AGJC_COPY");
			expect(kitty).toContain("file://");
			expect(kitty).not.toContain(ERASE);
			expect(kitty).toContain("badtail");
			const iterm = paint(ImageProtocol.Iterm2);
			expect(iterm).toContain("\u001b]1337;File=");
			expect(iterm).not.toContain(ERASE);
		} finally {
			release();
		}
	});

	it("still removes an original child after the card renders", () => {
		for (const held of [new Container(), new Box()]) {
			const child = new Text("REMOVE_ME", 0, 0) as Text & { dispose?: () => void };
			let disposed = 0;
			const orig = child.dispose?.bind(child);
			child.dispose = () => {
				disposed++;
				orig?.();
			};
			held.addChild(child);
			const tool = { label: "Hold", renderResult: () => held } as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			component.render(80);
			expect(held.children.includes(child)).toBe(true);
			if (held instanceof Container) expect(held.hasLiveChild(child)).toBe(true);
			held.detachChild(child);
			expect(disposed).toBe(0);
			expect(held.children.includes(child)).toBe(false);
			held.addChild(child);
			held.removeChild(child);
			expect(disposed).toBe(1);
			expect(component.render(80).join("\n")).not.toContain("REMOVE_ME");
		}
	});

	it("bounds output when a container returns twice the trusted-line cap", () => {
		const rows = 512;
		class Bulk extends Container {
			render(): string[] {
				const lines = [`head${ERASE}`];
				for (let i = 0; i < rows; i++) lines.push(`r${i}${ERASE}x`);
				return lines;
			}
		}
		const tool = { label: "Bulk", renderResult: () => new Bulk() } as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const lines = component.render(80);
		const painted = lines.join("\n");
		expect(lines.length).toBeLessThan(rows + 80);
		expect(painted).not.toContain(ERASE);
		expect(painted).toContain("head");
		expect(painted).toContain("r511x");
	});

	it("does not fail the card when a paint mac is not hex", () => {
		const paint = (body: string) => {
			const tool = {
				label: "Mac",
				renderResult() {
					return new Text(body, 0, 0);
				},
			} as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			return component.render(80);
		};
		for (const mac of ["é".repeat(32), "\uD800".repeat(32), "a".repeat(31), "g".repeat(32)]) {
			const lines = paint(`pre \u001b_AGJC_PAINT:${mac}:1\u001b\\xVISIBLE post`);
			const raw = lines.join("\n");
			expect(raw).toContain("xVISIBLE");
			expect(raw).toContain("pre");
			expect(raw).toContain("post");
			expect(raw).not.toContain("[render error");
			expect(raw).not.toContain("\u001b_AGJC_PAINT:");
		}
		const sibling = new Container();
		sibling.addChild(new Text("SIBLING", 0, 0));
		sibling.addChild(new Text(`\u001b_AGJC_PAINT:${"é".repeat(32)}:1\u001b\\xVISIBLE`, 0, 0));
		const tool = { label: "Mac", renderResult: () => sibling } as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const raw = component.render(80).join("\n");
		expect(raw).toContain("SIBLING");
		expect(raw).toContain("xVISIBLE");
		expect(raw).not.toContain("[render error");
	});

	it("keeps custom bash SIXEL when passthrough is on", () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		Bun.env.GJC_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.GJC_ALLOW_SIXEL_PASSTHROUGH = "1";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const paint = (renderResult: () => unknown) => {
			const tool = { label: "Img", renderResult } as unknown as AgentTool;
			const component = new ToolExecutionComponent("bash", { command: "img" }, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			return component.render(100).join("\n");
		};
		const bel = paint(() => ({
			render: () => "\u001bPq~-ok\u0007".split("\n"),
			invalidate() {},
		}));
		expect(bel).toContain("\u001bPq~-ok\u0007");
		const multi = paint(() => ({
			render: () => "\u001bPq\n#0!10~-payload\n\u001b\\".split("\n"),
			invalidate() {},
		}));
		expect(multi).toContain("\u001bPq");
		expect(multi).toContain("#0!10~-payload");
		expect(multi).toContain("\u001b\\");
		class SixelBox extends Container {
			render(): string[] {
				return ["\u001bPq", "#0!10~-payload", "\u001b\\"];
			}
		}
		const boxed = paint(() => new SixelBox());
		expect(boxed).toContain("\u001bPq");
		expect(boxed).toContain("#0!10~-payload");
		expect(boxed).toContain("\u001b\\");
	});

	it("strips erase added by a box background or a Markdown subclass", () => {
		const bgFn = (text: string) => `${text}${ERASE}`;
		const box = new Box(0, 0, bgFn);
		box.addChild(new Text("VISIBLE", 0, 0));
		const boxTool = { label: "Bg", renderResult: () => box } as unknown as AgentTool;
		const boxCard = new ToolExecutionComponent("custom-card", {}, {}, boxTool, uiStub, process.cwd());
		boxCard.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const boxRaw = boxCard.render(80).join("\n");
		expect(boxRaw).toContain("VISIBLE");
		expect(boxRaw).not.toContain(ERASE);
		expect(boxRaw).not.toContain("[render error");
		class BadMarkdown extends Markdown {
			render(): string[] {
				return [`left${ERASE}right`];
			}
		}
		const markdown = new BadMarkdown("plain", 0, 0, themeModule.getMarkdownTheme());
		const mdTool = { label: "Md", renderResult: () => markdown } as unknown as AgentTool;
		const mdCard = new ToolExecutionComponent("custom-card", {}, {}, mdTool, uiStub, process.cwd());
		mdCard.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const mdRaw = mdCard.render(80).join("\n");
		expect(mdRaw).toContain("leftright");
		expect(mdRaw).not.toContain(ERASE);
		expect(mdRaw).not.toContain("[render error");
	});

	it("keeps an Image when an overridden box paints a background", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyTransmitWriter(() => {});
		class BgBox extends Box {
			constructor() {
				super(0, 0, text => `\x1b[42m${text}\x1b[49m`);
			}
			render(width: number): string[] {
				this.clear();
				this.addChild(
					new Image(
						PNG,
						"image/png",
						{ fallbackColor: text => text },
						{ refetch: () => PNG },
						{ widthPx: 40, heightPx: 80 },
					),
				);
				return super.render(width);
			}
		}
		const tool = { label: "Bg", renderResult: () => new BgBox() } as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const raw = component.render(80).join("\n");
		expect(raw).toContain("\u001b_Ga=p");
		expect(raw).toContain("\u001b[42m");
		expect(raw).not.toContain("\u001b_AGJC_PAINT:");
		expect(raw).not.toContain(ERASE);
	});

	it("keeps every copy marker on a long delegated Markdown card", () => {
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			const source = Array.from(
				{ length: 300 },
				(_, i) => `Paragraph ${i} keeps \`tok${i}\` from notes/plan.ts.`,
			).join("\n\n");
			const markdown = new Markdown(source, 0, 0, themeModule.getMarkdownTheme());
			let childWidth = 0;
			const tool = {
				label: "Long",
				renderResult() {
					return {
						render: (width: number) => {
							childWidth = width;
							return markdown.render(width);
						},
						invalidate() {
							markdown.invalidate?.();
						},
					};
				},
			} as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			const card = component.render(100).join("\n");
			const direct = markdown.render(childWidth).join("\n");
			const directMarks = direct.split("\u001b_AGJC_COPY").length - 1;
			expect(childWidth).toBeGreaterThan(0);
			expect(directMarks).toBeGreaterThan(256);
			expect(card.split("\u001b_AGJC_COPY").length - 1).toBe(directMarks);
			expect(card).not.toContain("\u001b_AGJC_PAINT:");
			expect(card).toContain("Paragraph 0");
			expect(card).toContain("Paragraph 299");
			expect(card).not.toContain("fallback-marker");
		} finally {
			release();
		}
	});

	it("drops copy markers when a delegated line gains an erase", () => {
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			const source = "Paragraph keeps `tok` from notes/plan.ts.";
			const markdown = new Markdown(source, 0, 0, themeModule.getMarkdownTheme());
			const directMarks = markdown.render(80).join("\n").split("\u001b_AGJC_COPY").length - 1;
			expect(directMarks).toBeGreaterThan(0);
			const tool = {
				label: "Mut",
				renderResult() {
					return {
						render: (width: number) => markdown.render(width).map(line => `${line}${ERASE}`),
						invalidate() {
							markdown.invalidate?.();
						},
					};
				},
			} as unknown as AgentTool;
			const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
			component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
			const card = component.render(80).join("\n");
			expect(card).not.toContain(ERASE);
			expect(card).not.toContain("\u001b_AGJC_COPY");
			expect(card).not.toContain("\u001b_AGJC_PAINT:");
			expect(card).toContain("Paragraph keeps");
			const forged = `\u001b_AGJC_PAINT:${"ab".repeat(16)}:1\u001b\\${ERASE}`;
			const findRaw = renderFind([`notes/${forged}plan.ts`]);
			expect(findRaw).not.toContain(ERASE);
			expect(findRaw).not.toContain("\u001b_AGJC_PAINT:");
			expect(findRaw).toContain("notes/");
			expect(findRaw).toContain("plan.ts");
		} finally {
			release();
		}
	});

	it("filters a delegated line that gains a printable prefix or suffix", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyTransmitWriter(() => {});
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			const image = new Image(
				PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ refetch: () => PNG },
				{ widthPx: 40, heightPx: 80 },
			);
			const markdown = new Markdown(
				"Paragraph keeps `tok` from notes/plan.ts.",
				0,
				0,
				themeModule.getMarkdownTheme(),
			);
			const paint = (wrap: (line: string) => string) => {
				const tool = {
					label: "Wrap",
					renderResult() {
						return {
							render: (width: number) => [...image.render(width), ...markdown.render(width)].map(wrap),
							invalidate() {},
						};
					},
				} as unknown as AgentTool;
				const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
				component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
				return component.render(100);
			};
			const plain = paint(line => line).join("\n");
			expect(plain).toContain("\u001b_Ga=p");
			expect(plain).toContain("\u001b_AGJC_COPY");
			for (const wrap of [(line: string) => `│ ${line}`, (line: string) => `${line} ┃`]) {
				const lines = paint(wrap);
				const raw = lines.join("\n");
				expect(raw).toContain("Paragraph keeps");
				expect(raw).not.toContain("\u001b_");
				for (const line of lines) expect(await paintedLine(line)).toBe(line);
			}
		} finally {
			release();
		}
	});

	it("filters a Markdown render bound before the first tool card", async () => {
		const script = `
			const { Markdown, retainCopyAnnotations } = await import("@gajae-code/tui");
			const prebound = Markdown.prototype.render;
			const { Settings } = await import("@gajae-code/coding-agent/config/settings");
			await Settings.init({ inMemory: true, cwd: process.cwd() });
			const theme = await import("@gajae-code/coding-agent/modes/theme/theme");
			await theme.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
			const { ToolExecutionComponent } = await import("@gajae-code/coding-agent/modes/components/tool-execution");
			retainCopyAnnotations();
			const markdown = new Markdown("Paragraph keeps \\\`tok\\\` from notes/plan.ts.", 0, 0, theme.getMarkdownTheme());
			const paint = render => {
				const tool = { label: "Bound", renderResult: () => ({ render, invalidate() {} }) };
				const card = new ToolExecutionComponent("custom-card", {}, {}, tool, { requestRender() {} }, process.cwd());
				card.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
				return card.render(80);
			};
			const bound = paint(width => prebound.call(markdown, width));
			const later = paint(width => markdown.render(width));
			process.stdout.write(JSON.stringify({ bound, later }));
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`bound render probe failed (${code}): ${stderr}`);
		const { bound, later } = JSON.parse(stdout) as { bound: string[]; later: string[] };
		const raw = bound.join("\n");
		expect(raw).toContain("Paragraph keeps");
		expect(raw).not.toContain("\u001b_");
		for (const line of bound) expect(await paintedLine(line)).toBe(line);
		expect(later.join("\n")).toContain("\u001b_AGJC_COPY");
	}, 30_000);

	it("filters eval Markdown cell output inside its cell frame and keeps the file link", async () => {
		terminalState.hyperlinks = true;
		const release = retainCopyAnnotations();
		try {
			const output = "Result keeps `tok` from [plan](notes/plan.ts).";
			const direct = new Markdown(output, 0, 0, themeModule.getMarkdownTheme()).render(100).join("\n");
			expect(direct).toContain("\u001b_AGJC_COPY");
			const cell = { index: 0, code: "print(1)", language: "python", output, status: "complete", hasMarkdown: true };
			const component = new ToolExecutionComponent(
				"eval",
				{ cells: [{ language: "python", code: "print(1)" }] },
				{},
				undefined,
				uiStub,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: output }], details: { cells: [cell] } }, false);
			const lines = component.render(120);
			const raw = lines.join("\n");
			expect(raw).toContain("Result keeps");
			expect(raw).toContain("file://");
			expect(raw).not.toContain("\u001b_");
			for (const line of lines) expect(await paintedLine(line)).toBe(line);
		} finally {
			release();
		}
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[name];
	else Bun.env[name] = value;
}
