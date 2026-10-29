import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopSetting } from "../../desktop-host/src/protocol";
import { SettingField } from "../src/components";

function render(overrides: Partial<DesktopSetting>, pending = false): string {
	const setting: DesktopSetting = {
		path: "compaction.enabled",
		value: true,
		type: "boolean",
		description: "Enable automatic compaction.",
		writable: true,
		...overrides,
	};
	return renderToStaticMarkup(<SettingField setting={setting} pending={pending} onSave={() => {}} />);
}

/** The control a `<form class="setting-field">` actually renders. */
function control(html: string): string {
	const form = /<form[\s\S]*?<\/form>/u.exec(html)?.[0] ?? html;
	const match = /<(input|select)\b[^>]*>/u.exec(form)?.[0] ?? "";
	return match;
}

// Screenshot-free contract: each setting type must expose the control its value
// actually has, so a boolean is never a free-text "true"/"false" field.
describe("desktop setting field control types", () => {
	test("booleans render a checkbox reflecting the stored value", () => {
		const enabled = control(render({ value: true }));
		expect(enabled).toContain('type="checkbox"');
		expect(enabled).toContain("checked");
		expect(enabled).not.toContain('type="text"');

		const disabled = control(render({ value: false }));
		expect(disabled).toContain('type="checkbox"');
		expect(disabled).not.toContain("checked");
	});

	test("numbers render a decimal number input", () => {
		const html = control(render({ path: "sdk.promptDeadlineMs", type: "number", value: 3_600_000 }));
		expect(html).toContain('type="number"');
		expect(html).toContain('step="any"');
		expect(html).toContain('value="3600000"');
	});

	test("strings keep a text input", () => {
		const html = control(render({ path: "session.directoryMigration", type: "string", value: "copy-retain" }));
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
		expect(control(html)).toContain("<select");
		expect(html).toContain('<option selected="">copy-retain</option>');
		expect(html).toContain("<option>move</option>");
		expect(html).not.toContain('type="checkbox"');
	});

	test("the control itself is disabled when either the setting or the panel forbids saving", () => {
		expect(control(render({ writable: false }))).toContain("disabled");
		expect(control(render({}, true))).toContain("disabled");
		expect(control(render({}))).not.toContain("disabled");
	});

	test("a hand-edited value outside the option list stays selected", () => {
		const html = render({ path: "tools.spill", type: "number", value: 30, choices: ["100", "200"] });
		expect(html).toContain('<option selected="">30</option>');
		expect(html).toContain("<option>100</option>");
	});

	test("read-only settings explain themselves on the save action", () => {
		expect(render({ writable: false })).toContain("읽기 전용");
		expect(render({}, true)).toContain("연결 또는 처리 대기");
	});
});
