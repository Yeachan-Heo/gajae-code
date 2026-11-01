import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath } from "@gajae-code/utils";
import { clearMemoryData, getMemoryRoot } from "../../src/memories";
import { closeMemoryDb, openMemoryDb, upsertThreads } from "../../src/memories/storage";

const SLASH_PROJECT = "/var/proj/alpha";

describe("memory clear scope", () => {
	it("clears shared database rows and jobs globally while removing only the current directory", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-clear-global-db-"));
		const otherProject = "/var/other";
		try {
			const current = getMemoryRoot(agentDir, SLASH_PROJECT);
			const other = getMemoryRoot(agentDir, otherProject);
			expect(current).not.toBe(other);
			await fs.mkdir(current, { recursive: true });
			await fs.mkdir(other, { recursive: true });
			await Bun.write(path.join(current, "memory_summary.md"), "CURRENT_ONLY_TOKEN");
			await Bun.write(path.join(other, "memory_summary.md"), "OTHER_PROJECT_TOKEN");

			const db = openMemoryDb(getAgentDbPath(agentDir));
			try {
				upsertThreads(db, [
					{
						id: "thread-current",
						updatedAt: 1,
						rolloutPath: "current.jsonl",
						cwd: SLASH_PROJECT,
						sourceKind: "cli",
					},
					{
						id: "thread-other",
						updatedAt: 1,
						rolloutPath: "other.jsonl",
						cwd: otherProject,
						sourceKind: "cli",
					},
				]);
				db.prepare(
					"INSERT INTO jobs (kind, job_key, status, retry_remaining) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
				).run(
					"memory_stage1",
					"thread-other",
					"pending",
					1,
					"memory_consolidate_global",
					`global:${otherProject}`,
					"pending",
					1,
					"some_other_job",
					"x",
					"pending",
					1,
				);
			} finally {
				closeMemoryDb(db);
			}

			await clearMemoryData(agentDir, SLASH_PROJECT);

			await expect(fs.stat(current)).rejects.toThrow();
			expect(await Bun.file(path.join(other, "memory_summary.md")).text()).toBe("OTHER_PROJECT_TOKEN");
			const after = openMemoryDb(getAgentDbPath(agentDir));
			try {
				const threads = after.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number };
				const memoryJobs = after
					.prepare(
						"SELECT COUNT(*) AS count FROM jobs WHERE kind IN ('memory_stage1', 'memory_consolidate_global')",
					)
					.get() as { count: number };
				const otherJobs = after
					.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'some_other_job'")
					.get() as {
					count: number;
				};
				expect(threads.count).toBe(0);
				expect(memoryJobs.count).toBe(0);
				expect(otherJobs.count).toBe(1);
			} finally {
				closeMemoryDb(after);
			}
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("removes the current project memory directory", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-clear-slash-"));
		try {
			const current = getMemoryRoot(agentDir, SLASH_PROJECT);
			await fs.mkdir(current, { recursive: true });
			await Bun.write(path.join(current, "MEMORY.md"), "SLASH_ONLY_TOKEN");

			await clearMemoryData(agentDir, SLASH_PROJECT);

			await expect(fs.stat(current)).rejects.toThrow();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
