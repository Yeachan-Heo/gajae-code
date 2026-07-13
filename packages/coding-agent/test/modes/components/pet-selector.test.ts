import { beforeAll, describe, expect, it, vi } from "bun:test";
import {
	createPetSelectItems,
	getPetUnavailableWarning,
	PET_UNAVAILABLE_WARNING,
} from "@gajae-code/coding-agent/modes/components/pet-capability";
import { PetSelectorComponent } from "@gajae-code/coding-agent/modes/components/pet-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("PetSelectorComponent", () => {
	it("shows saved named pets but keeps unavailable ones unselectable", () => {
		const onSelect = vi.fn();
		const onPreview = vi.fn();
		const component = new PetSelectorComponent("red", onSelect, () => {}, onPreview, false);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("RedGajae (saved)");
		expect(rendered).toContain("BlueGajae");
		expect(rendered).toContain("Saved, unavailable");
		expect(stripAnsi(component.render(40).join("\n"))).toContain("RedGajae (saved)");
		expect(component.getSelectList().getSelectedItem()?.value).toBe("off");

		component.getSelectList().handleInput("\x1b[B");
		expect(component.getSelectList().getSelectedItem()?.value).toBe("off");
		expect(onPreview).not.toHaveBeenCalled();
	});

	it("decorates settings options through the shared capability policy", () => {
		const items = createPetSelectItems(
			[
				{ value: "off", label: "Off" },
				{ value: "red", label: "RedGajae" },
				{ value: "blue", label: "BlueGajae" },
			],
			"blue",
			false,
		);

		expect(items.find(item => item.value === "off")?.disabled).toBe(false);
		expect(items.find(item => item.value === "red")?.disabled).toBe(true);
		expect(items.find(item => item.value === "blue")?.description).toContain("Saved, unavailable");
	});

	it("preserves multiplexer-specific recovery guidance", () => {
		const warning = getPetUnavailableWarning({ TMUX: "/tmp/tmux-1/default,1,0" });
		expect(warning).toContain("outside the multiplexer");
		expect(warning).toContain("PI_FORCE_IMAGE_PROTOCOL=sixel");
		expect(getPetUnavailableWarning({})).toBe(PET_UNAVAILABLE_WARNING);
	});
});
