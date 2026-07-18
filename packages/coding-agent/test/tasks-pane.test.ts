import { describe, expect, test } from "bun:test";
import { taskItem } from "../src/modes/components/tasks-pane";

describe("TasksPaneComponent", () => {
	test("renders monitor badges and resumability metadata", () => {
		expect(
			taskItem({
				id: "bash:job-1",
				kind: "bash",
				label: "tail logs",
				status: "running",
				startedAt: 1,
				monitorOutputLines: 3,
			}),
		).toEqual({ value: "bash:job-1", label: "Running tail logs (3 lines)" });
		expect(
			taskItem({
				id: "subagent:a",
				kind: "subagent",
				label: "Research",
				status: "waiting",
				startedAt: 1,
				resumable: true,
			}),
		).toEqual({ value: "subagent:a", label: "Waiting Research [resumable]" });
	});
});
