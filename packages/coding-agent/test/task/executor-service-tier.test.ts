import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { createSubagentSettings } from "../../src/task/executor";

describe("createSubagentSettings service-tier override", () => {
	it("inherits the main session service tier by default", () => {
		const base = Settings.isolated({ serviceTier: "priority" });
		expect(base.get("task.serviceTier")).toBe("inherit");

		const subagent = createSubagentSettings(base);
		expect(subagent.get("serviceTier")).toBe("priority");
	});

	it("inherits the main session service tier when explicitly set to inherit", () => {
		const base = Settings.isolated({ serviceTier: "claude-only", "task.serviceTier": "inherit" });

		const subagent = createSubagentSettings(base);
		expect(subagent.get("serviceTier")).toBe("claude-only");
	});

	it("overrides the subagent service tier with an explicit value", () => {
		const base = Settings.isolated({ serviceTier: "none", "task.serviceTier": "priority" });

		const subagent = createSubagentSettings(base);
		expect(subagent.get("serviceTier")).toBe("priority");
	});

	it("can disable the subagent service tier while the main session keeps priority", () => {
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "none" });

		const subagent = createSubagentSettings(base);
		expect(subagent.get("serviceTier")).toBe("none");
		// Main session settings are untouched by the subagent override.
		expect(base.get("serviceTier")).toBe("priority");
	});
});
