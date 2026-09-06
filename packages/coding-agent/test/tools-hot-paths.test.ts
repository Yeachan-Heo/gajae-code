import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { getThemeByName } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { suffixPrefixOverlap } from "../src/tools/bash";
import { JobTool } from "../src/tools/job";
import { formatDiagnostics } from "../src/tools/render-utils";

describe("ACP snapshot overlap", () => {
	test.each([
		["", "abc", 0],
		["abc", "", 0],
		["abc", "abc", 3],
		["abc", "abcdef", 3],
		["abcdef", "defghi", 3],
		["ababab", "ababx", 4],
		["끝처음", "처음다음", 2],
		["abc", "xyz", 0],
	] as const)("%s -> %s retains %i code units", (source, target, overlap) => {
		expect(suffixPrefixOverlap(source, target)).toBe(overlap);
	});
});

describe("job poll progress cleanup", () => {
	test.each([1, 2])("unwatches and stops the timer when update %i throws", async throwAt => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async id => {
				delivered.push(id);
			},
		});
		AsyncJobManager.setInstance(manager);
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "pending", () => gate.promise);
		let calls = 0;
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "async.pollWaitDuration": "5s" }),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getAgentId: () => null,
		} as unknown as ToolSession;
		try {
			await expect(
				new JobTool(session).execute("poll", { poll: [jobId] }, undefined, () => {
					if (++calls === throwAt) throw new Error("progress failed");
				}),
			).rejects.toThrow("progress failed");
			gate.resolve("done");
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(delivered).toEqual([jobId]);
			await Bun.sleep(550);
			expect(calls).toBe(throwAt);
		} finally {
			gate.resolve("cleanup");
			await manager.dispose();
			AsyncJobManager.resetForTests();
		}
	});
});

test("diagnostics keep collapsed and expanded tree branches across many files", async () => {
	const theme = (await getThemeByName("red-claw"))!;
	for (const count of [1, 5, 6, 100]) {
		const messages = Array.from({ length: count }, (_, index) => `file-${index}.ts:1:2 [error] problem-${index}`);
		const diag = { errored: true, summary: `${count} errors`, messages };
		const collapsed = Bun.stripANSI(formatDiagnostics(diag, false, theme, () => "TS"));
		const expanded = Bun.stripANSI(formatDiagnostics(diag, true, theme, () => "TS"));
		expect(expanded.split("\n").filter(line => line.includes("TS file-"))).toHaveLength(count);
		expect(collapsed.split("\n").filter(line => line.includes("TS file-"))).toHaveLength(Math.min(count, 5));
		expect(expanded).toContain(` ${theme.tree.last} TS file-${count - 1}.ts`);
		if (count <= 5) expect(collapsed).toBe(expanded);
		else {
			expect(collapsed).toContain(`${count - 5} more`);
			expect(collapsed).toContain(` ${theme.tree.branch} TS file-4.ts`);
			expect(collapsed).not.toContain("problem-5");
		}
	}
});
