import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimStage1Jobs,
	clearMemoryData,
	closeMemoryDb,
	enqueueGlobalWatermark,
	markGlobalPhase2Failed,
	markGlobalPhase2FailedUnowned,
	openMemoryDb,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "@gajae-code/coding-agent/memories/storage";
import { Snowflake } from "@gajae-code/utils";

const GLOBAL_KIND = "memory_consolidate_global";
const PROJECT_CWD = "/repo";
const GLOBAL_KEY = `global:${PROJECT_CWD}`;

describe("memories/storage", () => {
	let testDir: string;
	let dbPath: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), "test-memories-storage", Snowflake.next());
		fs.mkdirSync(testDir, { recursive: true });
		dbPath = path.join(testDir, "state.db");
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("claimStage1Jobs excludes explicitly blocked thread IDs", () => {
		const db = openMemoryDb(dbPath);
		const nowSec = 1_800_000_000;
		upsertThreads(db, [
			{
				id: "active-thread",
				updatedAt: nowSec - 13 * 60 * 60,
				rolloutPath: "/tmp/active.jsonl",
				cwd: "/repo",
				sourceKind: "cli",
			},
			{
				id: "eligible-thread",
				updatedAt: nowSec - 13 * 60 * 60,
				rolloutPath: "/tmp/eligible.jsonl",
				cwd: "/repo",
				sourceKind: "cli",
			},
		]);

		const claims = claimStage1Jobs(db, {
			nowSec,
			threadScanLimit: 100,
			maxRolloutsPerStartup: 10,
			maxRolloutAgeDays: 30,
			minRolloutIdleHours: 12,
			leaseSeconds: 120,
			runningConcurrencyCap: 8,
			workerId: "test-worker",
			excludeThreadIds: ["active-thread"],
		});

		expect(claims.map(claim => claim.threadId)).toEqual(["eligible-thread"]);
		closeMemoryDb(db);
	});

	test("markGlobalPhase2FailedUnowned recovers lost ownership", () => {
		const db = openMemoryDb(dbPath);
		const nowSec = 1_800_000_000;
		enqueueGlobalWatermark(db, 100, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });

		const claim = tryClaimGlobalPhase2Job(db, {
			workerId: "test-worker",
			leaseSeconds: 60,
			nowSec,
			cwd: PROJECT_CWD,
		});
		expect(claim.kind).toBe("claimed");
		if (claim.kind !== "claimed") {
			closeMemoryDb(db);
			return;
		}

		db.prepare("UPDATE jobs SET ownership_token = NULL, lease_until = ? WHERE kind = ? AND job_key = ?").run(
			nowSec - 1,
			GLOBAL_KIND,
			GLOBAL_KEY,
		);

		const strict = markGlobalPhase2Failed(db, {
			ownershipToken: claim.claim.ownershipToken,
			retryDelaySeconds: 120,
			reason: "strict-fail",
			nowSec,
			cwd: PROJECT_CWD,
		});
		expect(strict).toBe(false);

		const fallback = markGlobalPhase2FailedUnowned(db, {
			retryDelaySeconds: 120,
			reason: "fallback-fail",
			nowSec,
			cwd: PROJECT_CWD,
		});
		expect(fallback).toBe(true);

		const row = db
			.prepare("SELECT status, last_error FROM jobs WHERE kind = ? AND job_key = ?")
			.get(GLOBAL_KIND, GLOBAL_KEY) as { status: string; last_error: string };
		expect(row.status).toBe("error");
		expect(row.last_error).toBe("fallback-fail");
		closeMemoryDb(db);
	});

	test("enqueueGlobalWatermark force-dirties when watermark does not advance", () => {
		const db = openMemoryDb(dbPath);
		enqueueGlobalWatermark(db, 100, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });
		db.prepare(
			"UPDATE jobs SET status = 'done', input_watermark = 100, last_success_watermark = 100, retry_remaining = 0, retry_at = 999 WHERE kind = ? AND job_key = ?",
		).run(GLOBAL_KIND, GLOBAL_KEY);

		enqueueGlobalWatermark(db, 80, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });
		const row = db
			.prepare(
				"SELECT input_watermark, last_success_watermark, retry_remaining, retry_at FROM jobs WHERE kind = ? AND job_key = ?",
			)
			.get(GLOBAL_KIND, GLOBAL_KEY) as {
			input_watermark: number;
			last_success_watermark: number;
			retry_remaining: number;
			retry_at: number | null;
		};
		expect(row.input_watermark).toBe(row.last_success_watermark + 1);
		expect(row.retry_remaining).toBe(3);
		expect(row.retry_at).toBeNull();
		closeMemoryDb(db);
	}, 10_000);

	test("clearMemoryData removes thread/output/job state", () => {
		const db = openMemoryDb(dbPath);
		upsertThreads(db, [
			{
				id: "thread-a",
				updatedAt: 100,
				rolloutPath: "/tmp/thread-a.jsonl",
				cwd: "/repo",
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-a", 100, "raw", "summary", null, 100);
		enqueueGlobalWatermark(db, 100, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });
		db.prepare(
			"INSERT INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark) VALUES (?, ?, ?, ?, ?, ?)",
		).run("some_other_job", "x", "pending", 1, 0, 0);

		clearMemoryData(db);

		const threadCount = db.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number };
		const outputCount = db.prepare("SELECT COUNT(*) AS count FROM stage1_outputs").get() as { count: number };
		const jobCount = db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number };
		expect(threadCount.count).toBe(0);
		expect(outputCount.count).toBe(0);
		expect(jobCount.count).toBe(1);
		closeMemoryDb(db);
	});
});
