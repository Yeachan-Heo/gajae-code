import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { ToolSession } from "../../src/tools/index";
import { JobTool, jobToolRenderer } from "../../src/tools/job";

function toolSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
		getAgentId: () => "owner-1",
		getAsyncJobManager: () => manager,
	} as unknown as ToolSession;
}

function renderResultLines(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(200).join("\n"));
}

describe("jobToolRenderer", () => {
	it("renders a paused job instead of failing the component render", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();

		// A folded background job is paused while it stays resumable, so the job
		// tool hands paused snapshots to this renderer.
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				jobs: [
					{
						id: "job-paused",
						type: "task",
						status: "paused",
						label: "paused subagent",
						durationMs: 1_000,
						foldReason: "steer",
					},
				],
			},
		};

		const component = jobToolRenderer.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme!);
		const rendered = renderResultLines(component);

		expect(rendered).toContain("job-paused");
		expect(rendered).toContain("paused subagent");
		expect(rendered).toContain("1 paused");
		expect(rendered).not.toContain("undefined");
	});

	it("does not report a paused-only snapshot as settled", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				jobs: [{ id: "job-paused", type: "task", status: "paused", label: "paused subagent", durationMs: 1_000 }],
			},
		};

		const component = jobToolRenderer.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme!);
		const rendered = renderResultLines(component);

		expect(rendered).toContain("waiting on 1 of 1");
		expect(rendered).not.toContain("settled");
		expect(rendered).toContain(uiTheme!.status.info);
	});

	it("renders a status this build does not know without reporting success", async () => {
		const uiTheme = await getThemeByName("red-claw");
		expect(uiTheme).toBeDefined();

		// Tool details are read back from persisted sessions, so a snapshot can
		// carry a status that is not in this build's union.
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				jobs: [{ id: "job-foreign", type: "bash", status: "deferred", label: "foreign status", durationMs: 5 }],
			},
		};

		const component = jobToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme!);
		const rendered = renderResultLines(component);

		expect(rendered).toContain("job-foreign");
		expect(rendered).not.toContain("undefined");
		expect(rendered).toContain("waiting on 1 of 1");
		expect(rendered).not.toContain("settled");
		expect(rendered).toContain("1 unknown");
	});
});

describe("job result text", () => {
	it("reports a paused job under Waiting instead of Completed", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		try {
			const jobId = manager.register(
				"task",
				"paused subagent",
				async () => ({ kind: "paused", note: "safe boundary" }),
				{ ownerId: "owner-1" },
			);
			await manager.waitForAll();
			expect(manager.getJob(jobId)?.status).toBe("paused");

			const tool = new JobTool(toolSession(manager));
			const result = await tool.execute("tool-call", { list: true });
			const text = result.content.find(part => part.type === "text")?.text ?? "";

			expect(text).toContain("## Waiting (1)");
			expect(text).toContain(`- \`${jobId}\` [task] — paused subagent (paused)`);
			expect(text).not.toContain("## Completed");
			expect(text).not.toContain("## Still Running");
			expect(result.details?.jobs[0]?.status).toBe("paused");
		} finally {
			await manager.dispose({ timeoutMs: 200 });
		}
	});
});
