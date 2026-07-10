import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";

describe("startup update contract", () => {
	it("keeps launch-time checks notify-only and explicit updates opt-in", () => {
		const setting = SETTINGS_SCHEMA["startup.checkUpdate"];

		expect(setting.default).toBe(true);
		expect(setting.ui.description).toContain("show a notification");
		expect(setting.ui.description).toContain("Startup never installs updates");
		expect(setting.ui.description).toContain("run `gjc update` explicitly");
		expect(setting.ui.description).toContain("If false, skip the check");
	});
});
