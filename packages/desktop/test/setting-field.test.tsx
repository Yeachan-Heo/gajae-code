import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopSetting } from "../../desktop-host/src/protocol";
import { SettingField } from "../src/components";

function render(overrides: Partial<DesktopSetting>): string {
	const setting: DesktopSetting = {
		path: "compaction.enabled",
		value: true,
		type: "boolean",
		description: "Enable automatic compaction.",
		writable: true,
		...overrides,
	};
	return renderToStaticMarkup(<SettingField setting={setting} onSave={() => {}} />);
}

// Screenshot-free contract: each setting type must expose the control its value
// actually has, so a boolean is never a free-text "true"/"false" field.
describe("desktop setting field control types", () => {
	test("booleans render a checkbox reflecting the stored value", () => {
		const enabled = render({ value: true });
		expect(enabled).toContain('type="checkbox"');
		expect(enabled).toContain("checked");
		expect(enabled).not.toContain('type="text"');

		const disabled = render({ value: false });
		expect(disabled).toContain('type="checkbox"');
		expect(disabled).not.toContain("checked");
	});

	test("numbers render a decimal number input", () => {
		const html = render({ path: "sdk.promptDeadlineMs", type: "number", value: 3_600_000 });
		expect(html).toContain('type="number"');
		expect(html).toContain('step="any"');
		expect(html).toContain('value="3600000"');
	});

	test("strings keep a text input", () => {
		const html = render({ path: "session.directoryMigration", type: "string", value: "copy-retain" });
		expect(html).toContain('type="text"');
		expect(html).toContain('value="copy-retain"');
	});

	test("enums keep a bounded select", () => {
		const html = render({
			path: "session.directoryMigration",
			type: "enum",
			value: "copy-retain",
			choices: ["copy-retain", "move"],
		});
		expect(html).toContain("<select");
		expect(html).toContain('<option selected="">copy-retain</option>');
		expect(html).toContain("<option>move</option>");
		expect(html).not.toContain('type="checkbox"');
	});

	test("read-only settings disable their control and save action", () => {
		const html = render({ writable: false });
		expect(html).toContain("disabled");
		expect(html).toContain("읽기 전용");
	});
});
