import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { createSubagentSettings } from "../../src/task/executor";

describe("createSubagentSettings service-tier inheritance", () => {
	it("inherits the LIVE parent session tier by default (not the stale settings snapshot)", () => {
		// Runtime `/fast on` lives on the live session tier, not settings: base
		// settings say `none`, but the live inherited tier must win.
		const base = Settings.isolated({ serviceTier: "none" });
		expect(base.get("task.serviceTier")).toBe("inherit");

		const subagent = createSubagentSettings(base, "priority");
		expect(subagent.get("serviceTier")).toBe("priority");
	});

	it("inherits a scoped live tier (openai-only) when task.serviceTier is inherit", () => {
		const base = Settings.isolated({ "task.serviceTier": "inherit" });
		const subagent = createSubagentSettings(base, "openai-only");
		expect(subagent.get("serviceTier")).toBe("openai-only");
	});

	it("inherits a scoped live tier (claude-only) when task.serviceTier is inherit", () => {
		const base = Settings.isolated({ "task.serviceTier": "inherit" });
		const subagent = createSubagentSettings(base, "claude-only");
		expect(subagent.get("serviceTier")).toBe("claude-only");
	});

	it("maps an undefined inherited tier to none on the inherit branch", () => {
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "inherit" });
		// No live tier passed (e.g. session tier is undefined) → subagent gets none,
		// regardless of the stale settings value.
		const subagent = createSubagentSettings(base, undefined);
		expect(subagent.get("serviceTier")).toBe("none");
	});

	it("lets an explicit task.serviceTier override win over the inherited live tier", () => {
		const base = Settings.isolated({ serviceTier: "none", "task.serviceTier": "priority" });
		const subagent = createSubagentSettings(base, undefined);
		expect(subagent.get("serviceTier")).toBe("priority");
	});

	it("can disable the subagent tier with an explicit none while the parent keeps priority", () => {
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "none" });
		const subagent = createSubagentSettings(base, "priority");
		expect(subagent.get("serviceTier")).toBe("none");
		// Main session settings are untouched by the subagent override.
		expect(base.get("serviceTier")).toBe("priority");
	});

	it("inheriting undefined (after /fast off) does not resurrect a startup tier", () => {
		// Regression: the live session tier is the source of truth. A session that
		// started with priority but later ran `/fast off` (live tier undefined) must
		// hand subagents `none`, never the stale startup value.
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "inherit" });
		const subagent = createSubagentSettings(base, undefined);
		expect(subagent.get("serviceTier")).toBe("none");
	});
});
