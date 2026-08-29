import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { AgentDashboard } from "../src/modes/components/agent-dashboard";
import { initTheme } from "../src/modes/theme/theme";
import * as discoveryModule from "../src/task/discovery";

describe("AgentDashboard profile authority", () => {
	it("passes the session-owned profile authority to agent discovery", async () => {
		await initTheme();
		const settings = Settings.isolated({}, { agentDir: "/tmp/gjc-dashboard-agent" });
		const discoverSpy = vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});

		try {
			await AgentDashboard.create("/tmp/gjc-dashboard-project", settings, 24, {
				agentDir: "/tmp/gjc-dashboard-agent",
				profileAuthority: "custom",
			});

			expect(discoverSpy).toHaveBeenCalledWith(
				"/tmp/gjc-dashboard-project",
				undefined,
				settings,
				"/tmp/gjc-dashboard-agent",
				"custom",
			);
		} finally {
			discoverSpy.mockRestore();
		}
	});
});
