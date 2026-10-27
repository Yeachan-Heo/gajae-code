import { beforeAll, describe, expect, it } from "bun:test";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import fc from "fast-check";
import type { ModelProfileConfig } from "../src/config/models-config-schema";
import { CustomModelPresetWizardComponent } from "../src/modes/components/custom-model-preset-wizard";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const ESC = "\u001b";
const BEL = "\u0007";
const OSC52 = `${ESC}]52;c;cGF5bG9hZA==${BEL}`;
const OSC0 = `${ESC}]0;pwned-title${BEL}`;
const OSC8 = `${ESC}]8;;https://attacker.invalid/track${BEL}`;
const OSC8_END = `${ESC}]8;;${BEL}`;
const ERASE_LINE = `${ESC}[2K`;
const ERASE_SCREEN = `${ESC}[2J`;
const SIXEL = `${ESC}P0qsecret-sixel${ESC}\\`;
const C1_OSC = "\u009d0;c1-title\u009c";
const BIDI = "\u202e";
const PROPERTY_SEED = 20261027;
const PROPERTY_RUNS = 64;

function plain(rendered: string): string {
	return Bun.stripANSI(rendered).replace(/\u001b\[[0-9;]*m/g, "");
}

function controlsAbsent(rendered: string): boolean {
	const text = plain(rendered);
	return !text.includes(ESC) && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text) && !text.includes(BIDI);
}

function renderWizard(snapshot: ModelProfileConfig): { rendered: string; submitted: unknown } {
	const submitted: unknown[] = [];
	const wizard = new CustomModelPresetWizardComponent(
		snapshot,
		input => submitted.push(input),
		() => {},
	);
	const rendered = wizard.render(240).join("\n");
	for (const char of "my-fast") wizard.handleInput(char);
	wizard.handleInput("\n");
	return { rendered, submitted: submitted[0] };
}

describe("custom model preset wizard snapshot preview", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("red-claw");
		expect(loaded).toBeDefined();
		setThemeInstance(loaded!);
	});

	it("drops terminal controls from the snapshot preview and keeps the saved selector", () => {
		const role = `exec${OSC0}utor`;
		const selector = `my-oai/${OSC52}gpt-custom:low${ERASE_LINE}${ERASE_SCREEN}${OSC8}link${OSC8_END}${SIXEL}${C1_OSC}\nnext${BIDI}`;
		const provider = `my-${OSC0}oai`;
		const snapshot = {
			required_providers: [provider],
			model_mapping: { [role]: selector },
		} as ModelProfileConfig;
		const { rendered, submitted } = renderWizard(snapshot);
		const text = plain(rendered);

		expect(controlsAbsent(rendered)).toBe(true);
		expect(rendered).not.toContain(`${ESC}]52;`);
		expect(rendered).not.toContain(`${ESC}]0;`);
		expect(rendered).not.toContain(`${ESC}]8;`);
		expect(rendered).not.toContain(ERASE_LINE);
		expect(rendered).not.toContain(ERASE_SCREEN);
		expect(rendered).not.toContain(`${ESC}P`);
		expect(rendered).not.toContain("cGF5bG9hZA");
		expect(rendered).not.toContain("pwned-title");
		expect(rendered).not.toContain("attacker.invalid");
		expect(rendered).not.toContain("secret-sixel");
		expect(rendered).not.toContain("c1-title");
		expect(rendered).not.toContain(BIDI);
		expect(text).toContain("executor: my-oai/gpt-custom:lowlink next");
		expect(text).toContain("providers: my-oai");
		expect(submitted).toEqual({
			name: "my-fast",
			profile: {
				display_name: "my-fast",
				required_providers: [provider],
				model_mapping: { [role]: selector },
			},
		});
	});

	it("still shows an ordinary selector, a fallback chain, and ordinary providers", () => {
		const snapshot: ModelProfileConfig = {
			required_providers: ["anthropic", "my-oai"],
			model_mapping: {
				default: "my-oai/gpt-custom:low",
				executor: ["anthropic/claude:low", "openai/gpt-custom"],
			},
		};
		const { rendered, submitted } = renderWizard(snapshot);
		const text = plain(rendered);

		expect(text).toContain("default: my-oai/gpt-custom:low");
		expect(text).toContain("executor: anthropic/claude:low,openai/gpt-custom");
		expect(text).toContain("providers: anthropic, my-oai");
		expect(text).toContain("Snapshot:");
		expect(submitted).toEqual({
			name: "my-fast",
			profile: {
				display_name: "my-fast",
				required_providers: ["anthropic", "my-oai"],
				model_mapping: {
					default: "my-oai/gpt-custom:low",
					executor: ["anthropic/claude:low", "openai/gpt-custom"],
				},
			},
		});
	});

	it("property: ordinary snapshot text stays visible, fc.property seed 20261027, numRuns 64", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z0-9._:/-]{1,24}$/),
				fc.stringMatching(/^[a-z0-9-]{1,16}$/),
				(model, provider) => {
					const selector = `${provider}/${model}`;
					const { rendered } = renderWizard({
						required_providers: [provider],
						model_mapping: { default: selector },
					});
					const text = plain(rendered);
					expect(text).toContain(`default: ${selector}`);
					expect(text).toContain(`providers: ${provider}`);
					expect(controlsAbsent(rendered)).toBe(true);
				},
			),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: preview lines agree with sanitizeDisplayLine and carry no controls, fc.property seed 20261027, numRuns 64", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 20 }), (selector, provider) => {
				const rawSelector = `${OSC52}${ERASE_SCREEN}${selector}\n${BIDI}`;
				const rawProvider = `${OSC0}${provider}`;
				const safeSelector = sanitizeDisplayLine(rawSelector);
				const safeProvider = sanitizeDisplayLine(rawProvider);
				const { rendered } = renderWizard({
					required_providers: [rawProvider],
					model_mapping: { default: rawSelector },
				});
				const text = plain(rendered);
				expect(controlsAbsent(rendered)).toBe(true);
				expect(text).toContain(`default: ${safeSelector}`);
				expect(text).toContain(`providers: ${safeProvider}`);
				expect(text).toContain(`default: ${sanitizeDisplayLine(safeSelector)}`);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});
});
