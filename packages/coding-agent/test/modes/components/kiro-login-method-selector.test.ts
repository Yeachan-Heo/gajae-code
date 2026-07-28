import { beforeAll, describe, expect, it } from "bun:test";
import {
	type KiroLoginMethod,
	KiroLoginMethodSelectorComponent,
} from "@gajae-code/coding-agent/modes/components/kiro-login-method-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderText(component: KiroLoginMethodSelectorComponent): string {
	return stripAnsi(component.render(80).join("\n"));
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("KiroLoginMethodSelectorComponent", () => {
	it("lists only the supported Kiro identity methods in order", () => {
		const component = new KiroLoginMethodSelectorComponent(
			() => {},
			() => {},
		);
		const rendered = renderText(component);
		expect(rendered).toContain("Select Kiro login method:");
		const labels = rendered
			.split("\n")
			.map(line => line.trim().replace(/^[^\p{L}]+/u, ""))
			.filter(line => line.length > 0 && line !== "Select Kiro login method:");
		expect(labels).toEqual(["Google", "GitHub", "AWS Builder ID"]);
	});

	it("reports the selected method and cancels without selecting", () => {
		const selections: KiroLoginMethod[] = [];
		let cancellations = 0;
		const component = new KiroLoginMethodSelectorComponent(
			method => selections.push(method),
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\x1b");

		expect(selections).toEqual(["google", "github", "builder-id"]);
		expect(cancellations).toBe(1);
	});
});
