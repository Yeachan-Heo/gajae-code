import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { completeReviewRun } from "../src/github-review/complete";
import type { GithubReviewConfig } from "../src/github-review/config";
import {
	DeliveryLog,
	type GithubReviewServer,
	startGithubReviewServer,
	verifySignature,
} from "../src/github-review/server";
import { ReviewService } from "../src/github-review/service";
import { detectMissedPrs, runSweep } from "../src/github-review/sweeper";

const SECRET = "s3cret";
const tmps: string[] = [];
const servers: GithubReviewServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(overrides: Partial<GithubReviewConfig> = {}): GithubReviewConfig {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghr-server-"));
	tmps.push(dataDir);
	return {
		appId: "1",
		installationId: "2",
		privateKeyPath: "/nonexistent.pem",
		webhookSecret: SECRET,
		botLogin: "gajae-code",
		botAliases: ["gajae"],
		botDisplayName: "가재",
		markerPrefix: "gajae",
		checkName: "가재 코드리뷰",
		host: "127.0.0.1",
		port: 0,
		webhookPath: "/webhooks/gajae",
		maxInflight: 4,
		turnTimeoutMinutes: 45,
		cwd: os.tmpdir(),
		dataDir,
		ignoreRepos: [],
		allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
		learnAssociations: ["OWNER"],
		repoConfigFile: ".gajae.yaml",
		inflightStaleSeconds: 20 * 60,
		sweepIntervalSeconds: 0,
		sweepStaleMinutes: 10,
		postCommand: "gajae-gh",
		completeCommand: "gajae-review-complete",
		localWebhookUrl: "http://127.0.0.1:0/webhooks/gajae",
		apiBase: "https://api.github.invalid",
		...overrides,
	};
}

function sign(body: string, secret = SECRET): string {
	return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Payload that reaches the router but resolves silently (bot author). */
const SILENT_PAYLOAD = JSON.stringify({
	action: "opened",
	number: 1,
	pull_request: { draft: false, user: { login: "x[bot]", type: "Bot" }, head: { sha: "a" } },
	repository: { full_name: "acme/web" },
});

async function post(server: GithubReviewServer, body: string, headers: Record<string, string>): Promise<Response> {
	return await fetch(`http://127.0.0.1:${server.port}/webhooks/gajae`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
}

describe("verifySignature", () => {
	const body = new TextEncoder().encode("payload");
	test("accepts a valid signature", () => {
		expect(verifySignature(SECRET, body, sign("payload"))).toBe(true);
	});
	test("rejects wrong secret, malformed header, missing header", () => {
		expect(verifySignature(SECRET, body, sign("payload", "other"))).toBe(false);
		expect(verifySignature(SECRET, body, "sha1=abc")).toBe(false);
		expect(verifySignature(SECRET, body, null)).toBe(false);
	});
});

describe("DeliveryLog", () => {
	test("dedupes and bounds memory", () => {
		const log = new DeliveryLog(undefined, 6 * 3600_000, 4);
		expect(log.alreadySeen("a")).toBe(false);
		expect(log.alreadySeen("a")).toBe(true);
		for (const id of ["b", "c", "d", "e"]) log.alreadySeen(id);
		// "a" was evicted by the capacity bound → treated as new again
		expect(log.alreadySeen("a")).toBe(false);
	});
});

describe("webhook server", () => {
	async function startServer(): Promise<GithubReviewServer> {
		const server = await startGithubReviewServer(testConfig(), () => {});
		servers.push(server);
		return server;
	}

	test("health reports runner load", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(await res.json()).toEqual({ ok: true, running: 0, queued: 0 });
	});

	test("rejects bad signatures with 401", async () => {
		const server = await startServer();
		const res = await post(server, SILENT_PAYLOAD, {
			"X-Hub-Signature-256": sign(SILENT_PAYLOAD, "wrong"),
			"X-GitHub-Event": "pull_request",
			"X-GitHub-Delivery": "d1",
		});
		expect(res.status).toBe(401);
	});

	test("filters events, dedupes deliveries, routes silent payloads", async () => {
		const server = await startServer();
		const headers = {
			"X-Hub-Signature-256": sign(SILENT_PAYLOAD),
			"X-GitHub-Event": "pull_request",
			"X-GitHub-Delivery": "d2",
		};
		const first = await post(server, SILENT_PAYLOAD, headers);
		expect(await first.json()).toEqual({ ok: true, skipped: "bot author" });
		const dup = await post(server, SILENT_PAYLOAD, headers);
		expect(await dup.json()).toEqual({ ok: true, skipped: "duplicate" });
		const wrongEvent = await post(server, SILENT_PAYLOAD, {
			...headers,
			"X-GitHub-Event": "push",
			"X-GitHub-Delivery": "d3",
		});
		expect(await wrongEvent.json()).toEqual({ ok: true, skipped: "event" });
		const notFound = await fetch(`http://127.0.0.1:${server.port}/nope`);
		expect(notFound.status).toBe(404);
	});
});

describe("completeReviewRun", () => {
	test("closes the stored check, flips the status line, drains pending via signed requeue", async () => {
		const config = testConfig();
		const service = new ReviewService(config);
		// Start a review with a pending supersede and a recorded check.
		await service.store.tryAcquireReview("acme/web", 42, "aaa");
		await service.store.setPrState("acme/web", 42, { check_id: 77 });
		await service.store.tryAcquireReview("acme/web", 42, "bbb");

		const closedChecks: Array<{ id: number; conclusion: string }> = [];
		const statusLines: string[] = [];
		const requeued: Array<{ pr: number; sha: string }> = [];
		service.closeCheck = async (_repo, _sha, checkId, conclusion) => {
			closedChecks.push({ id: checkId ?? -1, conclusion });
			return checkId ? 1 : 0;
		};
		service.upsertStatusLine = async (_repo, _pr, line) => {
			statusLines.push(line);
			return 1;
		};
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { number: number; pull_request: { head: { sha: string } } };
			requeued.push({ pr: body.number, sha: body.pull_request.head.sha });
			// requeue POSTs must be signed so the gateway accepts them
			const headers = init?.headers as Record<string, string>;
			const expected = `sha256=${crypto.createHmac("sha256", SECRET).update(String(init?.body)).digest("hex")}`;
			expect(headers["X-Hub-Signature-256"]).toBe(expected);
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		try {
			await completeReviewRun(service, "acme/web", 42, "aaa", "success");
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(closedChecks).toEqual([{ id: 77, conclusion: "success" }]);
		expect(statusLines).toHaveLength(1);
		expect(statusLines[0]).toContain("✅");
		expect(requeued).toEqual([{ pr: 42, sha: "bbb" }]);
		expect(service.store.getPrState("acme/web", 42).review_status).toBe("posted");
	});

	test("stale completion only closes its own check by sha", async () => {
		const config = testConfig();
		const service = new ReviewService(config);
		await service.store.tryAcquireReview("acme/web", 42, "newer");
		const closed: Array<number | null> = [];
		service.closeCheck = async (_repo, _sha, checkId) => {
			closed.push(checkId);
			return 0;
		};
		service.upsertStatusLine = async () => {
			throw new Error("stale completion must not touch the status line");
		};
		await completeReviewRun(service, "acme/web", 42, "older", "failure");
		expect(closed).toEqual([null]); // sha-lookup path, no stored id
		expect(service.store.getPrState("acme/web", 42).in_flight_sha).toBe("newer");
	});
});

describe("runSweep", () => {
	test("force-completes stale in-flight state through the idempotent completion path", async () => {
		const config = testConfig({ inflightStaleSeconds: 60 });
		const service = new ReviewService(config);
		await service.store.setPrState("acme/web", 7, {
			review_status: "in_flight",
			in_flight_sha: "deadsha",
			in_flight_since: Math.floor(Date.now() / 1000) - 3600,
			check_id: 5,
		});
		service.tokens.tokenOrEmpty = async () => "t";
		service.api.tryRequest = (async (apiPath: string) => {
			if (apiPath.includes("/pulls?")) return []; // no open PRs → no check sweep
			return null;
		}) as typeof service.api.tryRequest;
		const closed: Array<{ checkId: number | null; conclusion: string }> = [];
		service.closeCheck = async (_r, _s, checkId, conclusion) => {
			closed.push({ checkId, conclusion });
			return 1;
		};
		service.upsertStatusLine = async () => 1;
		const result = await runSweep(service, {});
		expect(result.forceCompleted).toBe(1);
		expect(closed).toEqual([{ checkId: 5, conclusion: "failure" }]);
		expect(service.store.getPrState("acme/web", 7).review_status).toBe("failed");
	});

	test("dry run reports without mutating", async () => {
		const config = testConfig({ inflightStaleSeconds: 60 });
		const service = new ReviewService(config);
		await service.store.setPrState("acme/web", 7, {
			review_status: "in_flight",
			in_flight_sha: "deadsha",
			in_flight_since: Math.floor(Date.now() / 1000) - 3600,
		});
		service.tokens.tokenOrEmpty = async () => "t";
		service.api.tryRequest = (async () => null) as typeof service.api.tryRequest;
		const result = await runSweep(service, { dryRun: true });
		expect(result.forceCompleted).toBe(1);
		expect(service.store.getPrState("acme/web", 7).review_status).toBe("in_flight");
	});
});

describe("detectMissedPrs", () => {
	const now = Date.parse("2026-07-24T12:00:00Z");
	const mkPr = (num: number, ageMin: number, extra: Record<string, unknown> = {}) => ({
		number: num,
		head: { sha: `sha${num}` },
		created_at: new Date(now - ageMin * 60_000).toISOString(),
		user: { login: "human", type: "User" },
		...extra,
	});

	test("flags human non-draft PRs without state inside [grace, lookback]", () => {
		const found = detectMissedPrs(
			new Set(["acme/web#1"]),
			"acme/web",
			[
				mkPr(1, 60), // has state → skip
				mkPr(2, 60), // → flagged
				mkPr(3, 5), // too fresh (grace) → skip
				mkPr(4, 26 * 60), // too old (lookback) → skip
				mkPr(5, 60, { draft: true }),
				mkPr(6, 60, { user: { login: "dep[bot]", type: "Bot" } }),
			],
			now,
		);
		expect(found).toEqual([{ repo: "acme/web", pr: 2, sha: "sha2", ageMin: 60 }]);
	});
});
