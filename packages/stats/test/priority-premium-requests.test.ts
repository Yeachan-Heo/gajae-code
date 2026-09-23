import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, getStatsDbPath, setAgentDir, TempDir } from "@gajae-code/utils";
import { getDashboardStats, syncAllSessions } from "../src/aggregator";
import { closeDb, getOverallStats, getRecentRequests } from "../src/db";
import { getSessionEntry, parseSessionFile } from "../src/parser";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-priority-"));
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

interface SessionLines {
	lines: Array<Record<string, unknown>>;
}

async function writeSession(folder: string, name: string, { lines }: SessionLines): Promise<string> {
	const dir = path.join(getSessionsDir(), folder);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, name);
	const text = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	await fs.writeFile(filePath, text);
	return filePath;
}

function assistantEntry(opts: {
	id: string;
	parentId?: string | null;
	provider: string;
	premiumRequests?: number;
	omitStopReason?: boolean;
}): Record<string, unknown> {
	return {
		type: "message",
		id: opts.id,
		parentId: opts.parentId ?? null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: opts.provider,
			model: "gpt-5.4",
			...(opts.omitStopReason ? {} : { stopReason: "stop" }),
			timestamp: Date.now(),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				...(opts.premiumRequests !== undefined ? { premiumRequests: opts.premiumRequests } : {}),
			},
		},
	};
}

describe("priority service-tier premium-request backfill", () => {
	it("skips malformed metadata between valid rows and advances incremental offsets", async () => {
		const valid = assistantEntry({ id: "before", provider: "openai" });
		const message = valid.message as Record<string, unknown>;
		const usage = message.usage as Record<string, unknown>;
		const malformed: unknown[] = [null, 1, "entry", [], { type: "message", id: "null-message", message: null }];
		for (const key of ["model", "provider", "api"]) {
			for (const value of [undefined, null, "", " ", 3, {}]) {
				malformed.push({ ...valid, id: `bad-${key}-${malformed.length}`, message: { ...message, [key]: value } });
			}
		}
		for (const value of [undefined, null, "usage", []]) {
			malformed.push({ ...valid, id: `bad-usage-${malformed.length}`, message: { ...message, usage: value } });
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
			for (const value of [undefined, null, "1", -1, Infinity]) {
				malformed.push({
					...valid,
					id: `bad-${key}-${malformed.length}`,
					message: { ...message, usage: { ...usage, [key]: value } },
				});
			}
		}
		for (const value of [undefined, null, "1", -1, Infinity]) {
			malformed.push({ ...valid, id: `bad-time-${malformed.length}`, message: { ...message, timestamp: value } });
		}
		const file = await writeSession("--tmp--proj", "metadata.jsonl", { lines: [valid] });
		const first = await parseSessionFile(file);
		const after = assistantEntry({ id: "after", provider: "openai" });
		await fs.appendFile(file, `${[...malformed, after].map(value => JSON.stringify(value)).join("\n")}\n`);
		const incremental = await parseSessionFile(file, first.newOffset);
		expect(first.stats.map(row => row.entryId)).toEqual(["before"]);
		expect(incremental.stats.map(row => row.entryId)).toEqual(["after"]);
		expect((await Bun.file(file).text()).slice(incremental.newOffset)).toBe("\n");
		expect((await parseSessionFile(file, incremental.newOffset)).stats).toEqual([]);
		await fs.appendFile(file, `${JSON.stringify({ ...after, id: "last" })}\n`);
		const last = await parseSessionFile(file, incremental.newOffset);
		expect(last.stats.map(row => row.entryId)).toEqual(["last"]);
		expect(await getSessionEntry(file, "after")).toEqual(after);
		expect(await getSessionEntry(file, "last")).toEqual({ ...after, id: "last" });
		expect(await getSessionEntry(file, "absent")).toBeNull();
		await syncAllSessions();
		expect(
			getRecentRequests()
				.map(row => row.entryId)
				.sort(),
		).toEqual(["after", "before", "last"]);
	});

	it("preserves fractional metadata and unknown identities while normalizing optional fields", async () => {
		const entry = assistantEntry({ id: "fractional", provider: "unknown-provider", premiumRequests: 0.5 });
		const message = entry.message as Record<string, unknown>;
		const usage = message.usage as Record<string, unknown>;
		message.model = "unknown-model";
		message.duration = "invalid";
		message.ttft = -1;
		message.errorMessage = {};
		message.stopReason = null;
		usage.input = 0.5;
		usage.output = 0;
		usage.totalTokens = 0.5;
		const entries = [entry];
		for (const premiumRequests of [null, "1", -1, Infinity]) {
			entries.push({
				...entry,
				id: `optional-${entries.length}`,
				message: { ...message, usage: { ...usage, premiumRequests } },
			});
		}
		await writeSession("--tmp--proj", "optional.jsonl", { lines: entries });
		await syncAllSessions();
		const requests = getRecentRequests();
		expect(requests).toHaveLength(5);
		for (const row of requests) {
			expect(row.model).toBe("unknown-model");
			expect(row.provider).toBe("unknown-provider");
			expect(row.duration).toBeNull();
			expect(row.ttft).toBeNull();
			expect(row.errorMessage).toBeNull();
			expect(row.stopReason).toBe("unknown");
			expect(row.usage.input).toBe(0.5);
			expect(row.usage.output).toBe(0);
			expect(row.usage.totalTokens).toBe(0.5);
			expect(row.usage.premiumRequests).toBe(row.entryId === "fractional" ? 0.5 : 0);
		}
	});

	it("retains fractional optional metrics and derives priority premium requests from invalid metadata", async () => {
		const entry = assistantEntry({ id: "priority-invalid", provider: "openai" });
		const message = entry.message as Record<string, unknown>;
		message.duration = 0.5;
		message.ttft = 0.25;
		(message.usage as Record<string, unknown>).premiumRequests = "invalid";
		await writeSession("--tmp--proj", "priority-invalid.jsonl", {
			lines: [{ type: "service_tier_change", serviceTier: "priority" }, entry],
		});
		await syncAllSessions();
		const request = getRecentRequests(1)[0];
		expect(request.duration).toBe(0.5);
		expect(request.ttft).toBe(0.25);
		expect(request.usage.premiumRequests).toBeGreaterThan(0);
	});
	it("preserves assistant messages that omit stopReason", async () => {
		await writeSession("--tmp--proj", "missing-stop-reason.jsonl", {
			lines: [
				{
					type: "session",
					version: 1,
					id: "missing-stop-reason",
					timestamp: new Date().toISOString(),
					cwd: "/tmp/proj",
				},
				assistantEntry({ id: "missing-stop-reason-entry", provider: "openai", omitStopReason: true }),
			],
		});

		await syncAllSessions();

		const request = getRecentRequests(1)[0];
		expect(request?.entryId).toBe("missing-stop-reason-entry");
		expect(request?.stopReason).toBe("unknown");
	});

	it("derives premium_requests from service_tier_change entries for OpenAI traffic", async () => {
		await writeSession("--tmp--proj", "01.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc1", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "a1", provider: "openai" }),
				assistantEntry({ id: "a2", provider: "openai-codex" }),
				// Direct Anthropic under priority tier counts as fast-mode premium.
				assistantEntry({ id: "a3", provider: "anthropic" }),
				{ type: "service_tier_change", id: "stc2", timestamp: new Date().toISOString(), serviceTier: null },
				assistantEntry({ id: "a4", provider: "openai" }),
			],
		});

		await syncAllSessions();

		const overall = await getOverallStats();
		expect(overall.totalRequests).toBe(4);
		expect(overall.totalPremiumRequests).toBe(3);
	});

	it("preserves an existing non-zero premiumRequests value (Copilot multiplier) even under priority tier", async () => {
		await writeSession("--tmp--proj", "02.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s2", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "b1", provider: "github-copilot", premiumRequests: 0.33 }),
			],
		});

		await syncAllSessions();

		const request = getRecentRequests(1)[0];
		expect(request?.usage.premiumRequests).toBeCloseTo(0.33, 6);
	});

	it("re-derives premium_requests on re-sync via UPSERT for sessions ingested before the fix", async () => {
		// Simulate the upgrade path: an older release already ingested a
		// priority OpenAI request with `premium_requests = 0` and persisted a
		// `file_offsets` row that says "fully ingested". On the next `initDb`
		// the new backfill sentinel is absent, so `file_offsets` is wiped and
		// the parser re-reads the session — this time deriving the priority
		// count from the recorded `service_tier_change` and upserting the row.
		const sessionFile = await writeSession("--tmp--proj", "03.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s3", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "c1", provider: "openai" }),
			],
		});

		// Bootstrap schema, then close so we can plant the stale-state fixtures
		// directly without going through a real parse.
		await syncAllSessions();
		closeDb();

		const sessionStats = await fs.stat(sessionFile);
		const raw = new Database(getStatsDbPath());
		raw.exec("DELETE FROM messages");
		raw.exec("DELETE FROM file_offsets");
		raw.exec("DELETE FROM meta WHERE key = 'premium_requests_priority_v1'");
		raw.prepare(
			`INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionFile,
			"c1",
			"/tmp/proj",
			"gpt-5.4",
			"openai",
			"openai-responses",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			10,
			5,
			0,
			0,
			15,
			0,
			0,
			0,
			0,
			0,
			0,
		);
		raw.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			sessionFile,
			sessionStats.size,
			sessionStats.mtimeMs,
		);
		raw.close();

		// Next sync triggers the priority backfill: clears `file_offsets`, the
		// parser re-derives `premium_requests = 1`, and the UPSERT updates the
		// stale row in place.
		await syncAllSessions();

		const request = getRecentRequests(1)[0];
		expect(request?.entryId).toBe("c1");
		expect(request?.usage.premiumRequests).toBe(1);
	});

	it("carries the active service tier across incremental parseSessionFile calls", async () => {
		// Session opens with priority, then a reply lands after we've already
		// advanced `fromOffset` past the tier-change entry. The parser must
		// replay the prefix and still attribute the reply as a premium request.
		const sessionFile = await writeSession("--tmp--proj", "04.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s4", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "d1", provider: "openai" }),
			],
		});

		// Locate the byte offset immediately past the `service_tier_change`
		// line so the second sync's `fromOffset` lands between the tier entry
		// and the assistant reply — the exact window where the regression hid.
		const bytes = await fs.readFile(sessionFile);
		const tierLineEnd = bytes.indexOf(0x0a, bytes.indexOf(Buffer.from("service_tier_change"))) + 1;
		expect(tierLineEnd).toBeGreaterThan(0);

		const second = await parseSessionFile(sessionFile, tierLineEnd);
		expect(second.stats).toHaveLength(1);
		expect(second.stats[0]?.entryId).toBe("d1");
		expect(second.stats[0]?.usage.premiumRequests).toBe(1);
	});
});

describe("agent role attribution", () => {
	it("groups root and role-agent requests while keeping legacy child roles unknown", async () => {
		const rootFile = await writeSession("--tmp--proj", "root.jsonl", {
			lines: [assistantEntry({ id: "root", provider: "openai" })],
		});
		const executorIdentity = {
			type: "configured_model_chain",
			id: "executor-chain",
			parentId: null,
			timestamp: new Date().toISOString(),
			role: "default",
			entries: ["openai/gpt-5.4"],
			origin: "subagent",
			identity: "executor",
			explicitHead: true,
		};
		const executorFile = await writeSession("--tmp--proj/root-session", "executor.jsonl", {
			lines: [executorIdentity, assistantEntry({ id: "executor-1", provider: "openai" })],
		});
		const firstExecutorParse = await parseSessionFile(executorFile);
		expect(firstExecutorParse.stats[0]?.agent).toBe("executor");

		await fs.appendFile(
			executorFile,
			`${JSON.stringify(assistantEntry({ id: "executor-2", provider: "openai" }))}\n`,
		);
		const incrementalExecutorParse = await parseSessionFile(executorFile, firstExecutorParse.newOffset);
		expect(incrementalExecutorParse.stats[0]?.agent).toBe("executor");

		const legacyChildFile = await writeSession("--tmp--proj/root-session", "legacy-child.jsonl", {
			lines: [assistantEntry({ id: "legacy-child", provider: "openai" })],
		});
		const customChildFile = await writeSession("--tmp--proj/root-session", "custom-child.jsonl", {
			lines: [
				{ ...executorIdentity, id: "custom-chain", identity: "custom-reviewer" },
				assistantEntry({ id: "custom-child", provider: "openai" }),
			],
		});

		expect((await parseSessionFile(rootFile)).stats[0]?.agent).toBe("default");
		expect((await parseSessionFile(legacyChildFile)).stats[0]?.agent).toBe("unknown");
		expect((await parseSessionFile(customChildFile)).stats[0]?.agent).toBe("other");

		await syncAllSessions();
		const dashboard = await getDashboardStats("all");
		const byAgent = new Map(dashboard.byAgent.map(row => [row.agent, row]));
		expect(dashboard.overall.totalRequests).toBe(5);
		expect(byAgent.get("default")?.totalRequests).toBe(1);
		expect(byAgent.get("executor")?.totalRequests).toBe(2);
		expect(byAgent.get("executor")?.totalInputTokens).toBe(20);
		expect(byAgent.get("other")?.totalRequests).toBe(1);
		expect(byAgent.get("unknown")?.totalRequests).toBe(1);
		expect(dashboard.byAgent.reduce((sum, row) => sum + row.totalRequests, 0)).toBe(dashboard.overall.totalRequests);
	});
});
