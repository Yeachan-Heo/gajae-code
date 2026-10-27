import { afterEach, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme, type Theme } from "../../src/modes/theme/theme";
import { writeToolRenderer } from "../../src/tools/write";

const ESC = "\u001b";
const BEL = "\u0007";
const MARKER = "visible-marker";
const LABEL = "link-label";
const POISON =
	`const ${MARKER} = 1; notify ${ESC}]0;pwned-title${BEL}` +
	` clip ${ESC}]52;c;cGF5bG9hZA==${BEL}` +
	` link ${ESC}]8;;https://attacker.invalid/track${BEL}${LABEL}${ESC}]8;;${BEL}` +
	` st ${ESC}]0;st-title${ESC}\\`;

const SIXEL_KEYS = [
	"GJC_FORCE_IMAGE_PROTOCOL",
	"PI_FORCE_IMAGE_PROTOCOL",
	"GJC_ALLOW_SIXEL_PASSTHROUGH",
	"PI_ALLOW_SIXEL_PASSTHROUGH",
] as const;

const savedSixel = new Map<string, string | undefined>();

function rememberSixelEnv(): void {
	for (const key of SIXEL_KEYS) savedSixel.set(key, Bun.env[key]);
}

function restoreSixelEnv(): void {
	for (const key of SIXEL_KEYS) {
		const value = savedSixel.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

async function highlightingOff(): Promise<void> {
	await initTheme(false, undefined, false, "red-claw", "blue-crab", false);
}

async function theme(): Promise<Theme> {
	const uiTheme = await getThemeByName("red-claw");
	expect(uiTheme).toBeDefined();
	return uiTheme!;
}

function resultText(uiTheme: Theme, content: string, expanded = true): string {
	return writeToolRenderer
		.renderResult({ content: [{ type: "text", text: "wrote" }] }, { expanded, isPartial: false }, uiTheme, {
			file_path: "src/demo.ts",
			content,
		})
		.render(400)
		.join("\n");
}

function callText(uiTheme: Theme, content: string): string {
	return writeToolRenderer
		.renderCall({ file_path: "src/demo.ts", content }, { expanded: false, isPartial: true }, uiTheme)
		.render(400)
		.join("\n");
}

function assertNoOsc(text: string): void {
	expect(text).not.toContain(`${ESC}]0;`);
	expect(text).not.toContain(`${ESC}]8;`);
	expect(text).not.toContain(`${ESC}]52;`);
	expect(text).not.toContain("pwned-title");
	expect(text).not.toContain("st-title");
	expect(text).not.toContain("attacker.invalid");
	expect(text).not.toContain("cGF5bG9hZA");
	expect(text).toContain(MARKER);
	expect(text).toContain(LABEL);
}

describe("writeToolRenderer display", () => {
	afterEach(async () => {
		restoreSixelEnv();
		await initTheme(false, undefined, false, "red-claw", "blue-crab", true);
	});

	it("strips osc controls from the write result and streaming preview", async () => {
		await highlightingOff();
		const uiTheme = await theme();
		const early = Array.from({ length: 14 }, (_, i) => `early-line-${i}`).join("\n");
		const streaming = `${early}\n${POISON}`;
		assertNoOsc(resultText(uiTheme, POISON, true));
		assertNoOsc(callText(uiTheme, streaming));
		expect(callText(uiTheme, streaming)).not.toContain("early-line-0");
	});

	it("keeps ordinary write preview source text", async () => {
		await highlightingOff();
		const uiTheme = await theme();
		const source = "export const keptValue = 42;\nconst second = keptValue;";
		const result = resultText(uiTheme, source, true);
		const call = callText(uiTheme, source);
		expect(result).toContain("keptValue");
		expect(result).toContain("src/demo.ts");
		expect(call).toContain("keptValue");
		expect(call).toContain("second");
	});

	it("keeps tab indented source text in the write preview", async () => {
		await highlightingOff();
		const uiTheme = await theme();
		const rendered = resultText(uiTheme, "\tconst indented = 1;", true);
		expect(rendered).toContain("const indented = 1;");
		expect(rendered).not.toContain("\tconst");
	});

	it("keeps a sixel image sequence when passthrough is enabled", async () => {
		rememberSixelEnv();
		Bun.env.GJC_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.GJC_ALLOW_SIXEL_PASSTHROUGH = "1";
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		await highlightingOff();
		const uiTheme = await theme();
		const sixel = `${ESC}P0qkept-sixel${ESC}\\`;
		const rendered = resultText(uiTheme, `before ${sixel} after`, true);
		expect(rendered).toContain(`${ESC}P0qkept-sixel${ESC}\\`);
		expect(rendered).toContain("before");
		expect(rendered).toContain("after");
	});
});
