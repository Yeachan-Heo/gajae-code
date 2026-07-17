import { describe, expect, it, setSystemTime } from "bun:test";
import type { BuildSystemPromptResult } from "@gajae-code/coding-agent/system-prompt";
import { buildSystemPrompt, buildVolatileProjectContext } from "@gajae-code/coding-agent/system-prompt";
import type { WorkspaceTree } from "@gajae-code/coding-agent/workspace-tree";
import { hashPrefix } from "../../orchestration-token-benchmark/src/prefix-stability";

function workspaceTree(rendered: string): WorkspaceTree {
	return {
		rootPath: "/tmp/project",
		rendered,
		truncated: false,
		totalLines: rendered.split("\n").length,
		agentsMdFiles: [],
	};
}

describe("volatile project context", () => {
	it("keeps volatile facts out of the stable system prefix while rendering them per turn", async () => {
		const treeOne = workspaceTree(".\n  - old.txt  1B  2d ago");
		const treeTwo = workspaceTree(".\n  - new.txt  1B  1s ago");
		const promptOne = await buildSystemPrompt({
			cwd: "/tmp/project",
			workspaceTree: treeOne,
			contextFiles: [],
			skills: [],
			toolNames: [],
		});
		const promptTwo = await buildSystemPrompt({
			cwd: "/tmp/project",
			workspaceTree: treeTwo,
			contextFiles: [],
			skills: [],
			toolNames: [],
		});

		expect(promptOne.systemPrompt.join("\n\n")).not.toContain("old.txt");
		expect(promptTwo.systemPrompt.join("\n\n")).not.toContain("new.txt");
		expect(promptOne.systemPrompt.join("\n\n")).not.toContain("Today is");
		expect(hashPrefix(JSON.stringify(promptOne.systemPrompt))).toBe(
			hashPrefix(JSON.stringify(promptTwo.systemPrompt)),
		);

		const volatileOne = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-06",
			workspaceTree: treeOne,
		});
		const volatileTwo = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-07",
			workspaceTree: treeTwo,
		});

		expect(volatileOne).toContain("Today is 2026-07-06");
		expect(volatileOne).toContain("current working directory is '/tmp/project'");
		expect(volatileOne).toContain("old.txt");
		expect(volatileTwo).toContain("Today is 2026-07-07");
		expect(volatileTwo).toContain("current working directory is '/tmp/project'");
		expect(volatileTwo).toContain("new.txt");
	});

	it("keeps the stable prefix byte-identical across volatile date and tree permutations", async () => {
		const permutations = [
			{ date: "2026-01-01", cwd: "/tmp/project-a", tree: workspaceTree(".\n  - alpha.txt  1B  1d ago") },
			{ date: "2027-02-02", cwd: "/tmp/project-b", tree: workspaceTree(".\n  - beta.ts  2B  2h ago") },
			{ date: "2028-03-03", cwd: "/tmp/project-c", tree: workspaceTree(".\n  - gamma.md  3B  3s ago") },
		];

		const builtPrompts: BuildSystemPromptResult[] = [];
		try {
			for (const permutation of permutations) {
				setSystemTime(new Date(`${permutation.date}T00:00:00Z`));
				builtPrompts.push(
					await buildSystemPrompt({
						cwd: permutation.cwd,
						workspaceTree: permutation.tree,
						contextFiles: [],
						skills: [],
						toolNames: [],
					}),
				);
			}
		} finally {
			setSystemTime();
		}
		const hashes = builtPrompts.map(builtPrompt => hashPrefix(JSON.stringify(builtPrompt.systemPrompt)));
		const stablePrefixes = builtPrompts.map(builtPrompt => builtPrompt.systemPrompt.join("\n\n"));

		expect(new Set(hashes).size).toBe(1);
		for (const stablePrefix of stablePrefixes) {
			expect(stablePrefix).not.toContain("Today is");
			expect(stablePrefix).not.toContain("<workspace-tree>");
			expect(stablePrefix).not.toContain("current working directory is");
		}
	});

	it("renders volatile facts per turn and omits the workspace-tree block when no tree is rendered", () => {
		const tree = workspaceTree(".\n  - visible.txt  4B  4m ago");
		const withTree = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-06",
			workspaceTree: tree,
		});
		const withoutTree = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-07",
			workspaceTree: workspaceTree(""),
		});

		expect(withTree).toContain("<system-reminder>");
		expect(withTree).toContain("</system-reminder>");
		expect(withTree).toContain("<workspace-tree>");
		expect(withTree).toContain("visible.txt");
		expect(withTree).toContain("Today is 2026-07-06");
		expect(withTree).toContain("current working directory is '/tmp/project'");

		expect(withoutTree).toContain("<system-reminder>");
		expect(withoutTree).toContain("</system-reminder>");
		expect(withoutTree).toContain("Today is 2026-07-07");
		expect(withoutTree).toContain("current working directory is '/tmp/project'");
		expect(withoutTree).not.toContain("<workspace-tree>");
		expect(withoutTree).not.toContain("</workspace-tree>");
	});
});
