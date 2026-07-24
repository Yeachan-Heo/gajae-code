import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GithubReviewConfig } from "../src/github-review/config";
import { parseMinimalYaml, type RepoReviewConfig } from "../src/github-review/repo-config";
import { type RouteAction, WebhookRouter } from "../src/github-review/router";
import { mentionsBot, parseCommand, ReviewService } from "../src/github-review/service";

const tmps: string[] = [];
afterEach(() => {
	for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(dataDir: string, overrides: Partial<GithubReviewConfig> = {}): GithubReviewConfig {
	return {
		appId: "1",
		installationId: "2",
		privateKeyPath: "/nonexistent.pem",
		webhookSecret: "s3cret",
		botLogin: "gajae-code",
		botAliases: ["gajae", "가재"],
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
		ignoreRepos: ["polybetbot"],
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

interface Harness {
	router: WebhookRouter;
	service: ReviewService;
	acks: Array<{ commentId: number | undefined; reviewComment: boolean }>;
	startAcks: Array<{ repo: string; pr: number; sha: string }>;
}

/** Router harness with all network lanes stubbed out. */
function makeHarness(
	options: { config?: Partial<GithubReviewConfig>; repoConfig?: RepoReviewConfig; headSha?: string } = {},
): Harness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghr-router-"));
	tmps.push(dir);
	const config = testConfig(dir, options.config);
	const service = new ReviewService(config);
	const acks: Harness["acks"] = [];
	const startAcks: Harness["startAcks"] = [];
	service.tokens.tokenOrEmpty = async () => "test-token";
	service.api.tryRequest = (async (apiPath: string) => {
		if (apiPath.includes("/contents/") && options.repoConfig !== undefined) {
			// Serve the repo config as a contents API blob.
			const yaml = Object.entries(options.repoConfig)
				.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
				.join("\n");
			return { content: Buffer.from(yaml).toString("base64") };
		}
		if (/\/pulls\/\d+$/.test(apiPath)) return { head: { sha: options.headSha ?? "" } };
		return null;
	}) as typeof service.api.tryRequest;
	service.ackReaction = async (_repo, commentId, reviewComment = false) => {
		acks.push({ commentId, reviewComment });
		return true;
	};
	service.startReviewAcks = async (repo, pr, sha) => {
		startAcks.push({ repo, pr, sha });
		return null;
	};
	return { router: new WebhookRouter(config, service), service, acks, startAcks };
}

function prEvent(
	overrides: Record<string, unknown> = {},
	prOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		action: "opened",
		number: 42,
		pull_request: {
			draft: false,
			author_association: "OWNER",
			user: { login: "human", type: "User" },
			head: { sha: "abc1234def" },
			...prOverrides,
		},
		repository: { full_name: "acme/web" },
		...overrides,
	};
}

function commentEvent(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "created",
		issue: { number: 42, title: "T", pull_request: {} },
		comment: { id: 7, body, author_association: "OWNER", user: { login: "human", type: "User" } },
		repository: { full_name: "acme/web" },
		...overrides,
	};
}

function asRun(action: RouteAction): Extract<RouteAction, { kind: "run" }> {
	expect(action.kind).toBe("run");
	return action as Extract<RouteAction, { kind: "run" }>;
}

describe("pull_request auto review", () => {
	test("opened → full review with gate, acks, complete line, metadata", async () => {
		const h = makeHarness();
		const action = asRun(await h.router.route(prEvent()));
		expect(action.instruction).toContain("자동 코드리뷰");
		expect(action.instruction).toContain("gh pr diff 42 --repo acme/web");
		expect(action.instruction).toContain("gajae-review-complete acme/web 42 abc1234def success");
		expect(action.instruction).toContain("gitleaks");
		expect(action.instruction).toContain('select(.user.login=="gajae-code[bot]")'); // dedup step
		expect(action.review).toEqual({ repo: "acme/web", pr: 42, sha: "abc1234def" });
		expect(h.startAcks).toEqual([{ repo: "acme/web", pr: 42, sha: "abc1234def" }]);
		expect(h.service.store.getPrState("acme/web", 42).in_flight_sha).toBe("abc1234def");
	});

	test.each(["closed", "labeled", "review_requested"])("action %s → silent", async action => {
		const h = makeHarness();
		expect((await h.router.route(prEvent({ action }))).kind).toBe("silent");
	});

	test("draft / bot author / ignored repo → silent", async () => {
		const h = makeHarness();
		expect((await h.router.route(prEvent({}, { draft: true }))).kind).toBe("silent");
		expect((await h.router.route(prEvent({}, { user: { login: "dep[bot]", type: "Bot" } }))).kind).toBe("silent");
		expect((await h.router.route(prEvent({ repository: { full_name: "acme/PolyBetBot-api" } }))).kind).toBe("silent");
	});

	test("paused PR → silent", async () => {
		const h = makeHarness();
		await h.service.store.setPrState("acme/web", 42, { paused: true });
		expect((await h.router.route(prEvent())).kind).toBe("silent");
	});

	test("same sha already reviewed → silent (redelivery guard)", async () => {
		const h = makeHarness();
		await h.service.store.setPrState("acme/web", 42, { last_reviewed_sha: "abc1234def" });
		expect((await h.router.route(prEvent({ action: "synchronize" }))).kind).toBe("silent");
	});

	test("gate: duplicate and supersede are silent on the auto path", async () => {
		const h = makeHarness();
		await h.router.route(prEvent());
		expect((await h.router.route(prEvent())).kind).toBe("silent"); // duplicate
		const superseded = await h.router.route(prEvent({}, { head: { sha: "newsha0000" } }));
		expect(superseded.kind).toBe("silent");
		expect(h.service.store.getPrState("acme/web", 42).pending_sha).toBe("newsha0000");
	});

	test("synchronize after a review → incremental (compare, resolve step, no dedup)", async () => {
		const h = makeHarness();
		await h.service.store.setPrState("acme/web", 42, { last_reviewed_sha: "oldsha9999" });
		const action = asRun(await h.router.route(prEvent({ action: "synchronize" })));
		expect(action.instruction).toContain("repos/acme/web/compare/oldsha9999...abc1234def");
		expect(action.instruction).toContain("증분");
		expect(action.instruction).toContain("resolveReviewThread");
		expect(action.instruction).not.toContain("중복 방지");
	});

	test("repo config: enabled:false → silent", async () => {
		const h = makeHarness({ repoConfig: { enabled: false } });
		expect((await h.router.route(prEvent())).kind).toBe("silent");
	});

	test("repo config knobs flow into the instruction", async () => {
		const h = makeHarness({
			repoConfig: { max_comments: 3, tone: "부드럽게", ignore_paths: ["dist/", "gen/"] },
		});
		const action = asRun(await h.router.route(prEvent()));
		expect(action.instruction).toContain("최대 3개로 제한");
		expect(action.instruction).toContain("톤: 부드럽게");
		expect(action.instruction).toContain("dist/, gen/");
	});

	test("poem included by default, omitted with poem:false", async () => {
		const withPoem = asRun(await makeHarness().router.route(prEvent()));
		expect(withPoem.instruction).toContain("시 한 편");
		expect(withPoem.instruction).toContain("🦞");
		const without = asRun(await makeHarness({ repoConfig: { poem: false } }).router.route(prEvent()));
		expect(without.instruction).not.toContain("시 한 편");
	});

	test("diagrams:false and pr_summary:false trim the summary steps", async () => {
		const h = makeHarness({ repoConfig: { diagrams: false, pr_summary: false } });
		const action = asRun(await h.router.route(prEvent()));
		expect(action.instruction).not.toContain("mermaid");
		expect(action.instruction).not.toContain("PR **본문**");
	});

	test("learnings are injected", async () => {
		const h = makeHarness();
		h.service.addLearning("acme/web", "모든 API 에러는 problem+json");
		const action = asRun(await h.router.route(prEvent()));
		expect(action.instruction).toContain("학습된 규칙");
		expect(action.instruction).toContain("problem+json");
	});
});

describe("issue_comment commands", () => {
	test("@gajae help → canned reply, ack fired", async () => {
		const h = makeHarness();
		const action = asRun(await h.router.route(commentEvent("@gajae help")));
		expect(action.instruction).toContain("가재 명령어");
		expect(action.instruction).toContain("딱 하나만 그대로");
		expect(h.acks).toEqual([{ commentId: 7, reviewComment: false }]);
	});

	test("@gajae summary → summary instruction", async () => {
		const action = asRun(await makeHarness().router.route(commentEvent("@gajae summary")));
		expect(action.instruction).toContain("<!-- gajae-summary -->");
		expect(action.instruction).toContain("walkthrough");
	});

	test("가재 리뷰 (korean alias + command) routes to review", async () => {
		const h = makeHarness({ headSha: "abc1234def" });
		const action = asRun(await h.router.route(commentEvent("가재 리뷰 부탁해")));
		expect(action.instruction).toContain("강제 리뷰");
		expect(action.review).toEqual({ repo: "acme/web", pr: 42, sha: "abc1234def" });
	});

	test("@gajae review with unresolvable sha falls back to $SHA flow", async () => {
		const h = makeHarness({ headSha: "" });
		const action = asRun(await h.router.route(commentEvent("@gajae review")));
		expect(action.instruction).toContain("$SHA");
		expect(action.review).toBeUndefined();
	});

	test("@gajae review honors the gate: duplicate notifies once, then silent", async () => {
		const h = makeHarness({ headSha: "abc1234def" });
		await h.service.store.tryAcquireReview("acme/web", 42, "abc1234def");
		const first = asRun(await h.router.route(commentEvent("@gajae review")));
		expect(first.instruction).toContain("이미 이 커밋");
		const second = await h.router.route(commentEvent("@gajae review"));
		expect(second.kind).toBe("silent");
	});

	test("@gajae review supersede / queue replies", async () => {
		const h = makeHarness({ headSha: "newsha0000" });
		await h.service.store.tryAcquireReview("acme/web", 42, "oldsha1111");
		const superseded = asRun(await h.router.route(commentEvent("@gajae review")));
		expect(superseded.instruction).toContain("다시 리뷰할게");

		const q = makeHarness({ headSha: "abc1234def", config: { maxInflight: 1 } });
		await q.service.store.tryAcquireReview("acme/other", 9, "zzz");
		const queued = asRun(await q.router.route(commentEvent("@gajae review")));
		expect(queued.instruction).toContain("대기열");
	});

	test("@gajae pause / resume flip state and reply", async () => {
		const h = makeHarness();
		const paused = asRun(await h.router.route(commentEvent("@gajae pause")));
		expect(paused.instruction).toContain("일시정지");
		expect(h.service.store.getPrState("acme/web", 42).paused).toBe(true);
		const resumed = asRun(await h.router.route(commentEvent("@gajae resume")));
		expect(resumed.instruction).toContain("재개");
		expect(h.service.store.getPrState("acme/web", 42).paused).toBe(false);
	});

	test("@gajae learn stores the rule and confirms", async () => {
		const h = makeHarness();
		const action = asRun(await h.router.route(commentEvent("@gajae learn 커밋은 conventional commits")));
		expect(action.instruction).toContain("학습함");
		expect(h.service.getLearnings("acme/web")).toContain("conventional commits");
	});

	test("@gajae fix / resolve build the right instructions", async () => {
		const h = makeHarness();
		const fix = asRun(await h.router.route(commentEvent("@gajae fix null 체크 추가해줘")));
		expect(fix.instruction).toContain("suggestion");
		expect(fix.instruction).toContain("push/commit/브랜치 수정 금지");
		const resolve = asRun(await h.router.route(commentEvent("@gajae resolve")));
		expect(resolve.instruction).toContain('repository(owner:"acme",name:"web")');
		expect(resolve.instruction).toContain("resolveReviewThread");
	});

	test("plain mention → chat; no mention → silent; bot author → silent", async () => {
		const h = makeHarness();
		const chat = asRun(await h.router.route(commentEvent("가재야 이 PR 어때?")));
		expect(chat.instruction).toContain("한국어 반말");
		expect((await h.router.route(commentEvent("그냥 사람들끼리 대화"))).kind).toBe("silent");
		expect(
			(
				await h.router.route(
					commentEvent("@gajae review", {
						comment: { id: 7, body: "@gajae review", user: { login: "x[bot]", type: "Bot" } },
					}),
				)
			).kind,
		).toBe("silent");
	});

	test("edited comments only count when they carry a command", async () => {
		const h = makeHarness();
		expect((await h.router.route(commentEvent("가재야 안녕", { action: "edited" }))).kind).toBe("silent");
		const edited = await h.router.route(commentEvent("@gajae help", { action: "edited" }));
		expect(edited.kind).toBe("run");
	});

	test("non-PR issue comment → silent", async () => {
		const h = makeHarness();
		expect((await h.router.route(commentEvent("@gajae help", { issue: { number: 42, title: "T" } }))).kind).toBe(
			"silent",
		);
	});
});

describe("pull_request_review_comment", () => {
	function reviewCommentEvent(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			action: "created",
			pull_request: { number: 42 },
			comment: {
				id: 55,
				pull_request_review_id: 999,
				path: "src/a.ts",
				line: 10,
				diff_hunk: "@@ -1 +1 @@",
				body,
				author_association: "MEMBER",
				user: { login: "human", type: "User" },
			},
			repository: { full_name: "acme/web" },
			...overrides,
		};
	}

	test("mention in a diff thread → threaded reply instruction + 👀 ack", async () => {
		const h = makeHarness();
		const action = asRun(await h.router.route(reviewCommentEvent("@gajae 이 라인 왜 이래?")));
		expect(action.instruction).toContain("repos/acme/web/pulls/42/comments/55/replies");
		expect(action.instruction).toContain("src/a.ts");
		expect(h.acks).toEqual([{ commentId: 55, reviewComment: true }]);
	});

	test("no mention / bot author / non-created → silent", async () => {
		const h = makeHarness();
		expect((await h.router.route(reviewCommentEvent("그냥 리뷰 코멘트"))).kind).toBe("silent");
		expect((await h.router.route(reviewCommentEvent("@gajae hi", { action: "edited" }))).kind).toBe("silent");
	});
});

describe("authorization gates", () => {
	test("untrusted commenter: command and chat are dropped with no ack, no session", async () => {
		const h = makeHarness();
		const evt = commentEvent("@gajae review");
		(evt.comment as Record<string, unknown>).author_association = "NONE";
		const action = await h.router.route(evt);
		expect(action.kind).toBe("silent");
		const chat = commentEvent("가재야 이거 어때?");
		(chat.comment as Record<string, unknown>).author_association = "FIRST_TIME_CONTRIBUTOR";
		expect((await h.router.route(chat)).kind).toBe("silent");
		expect(h.acks).toEqual([]); // no 👀 for unauthorized authors
	});

	test("untrusted inline review commenter is dropped before ack", async () => {
		const h = makeHarness();
		const evt = {
			action: "created",
			pull_request: { number: 42 },
			comment: {
				id: 55,
				pull_request_review_id: 999,
				path: "src/a.ts",
				line: 10,
				diff_hunk: "@@",
				body: "@gajae 왜 이래?",
				author_association: "NONE",
				user: { login: "rando", type: "User" },
			},
			repository: { full_name: "acme/web" },
		};
		expect((await h.router.route(evt)).kind).toBe("silent");
		expect(h.acks).toEqual([]);
	});

	test("learn requires learnAssociations (OWNER); members get a refusal reply", async () => {
		const h = makeHarness();
		const evt = commentEvent("@gajae learn 아무 규칙");
		(evt.comment as Record<string, unknown>).author_association = "MEMBER";
		const action = asRun(await h.router.route(evt));
		expect(action.instruction).toContain("🔒");
		expect(h.service.getLearnings("acme/web")).toBe("");
		const owner = commentEvent("@gajae learn 진짜 규칙");
		const learned = asRun(await h.router.route(owner));
		expect(learned.instruction).toContain("학습함");
		expect(h.service.getLearnings("acme/web")).toContain("진짜 규칙");
	});

	test("untrusted PR author still gets a review, but WITHOUT user-token thread cleanup", async () => {
		const h = makeHarness();
		await h.service.store.setPrState("acme/web", 42, { last_reviewed_sha: "oldsha9999" });
		const evt = prEvent({ action: "synchronize" }, { author_association: "NONE" });
		const action = asRun(await h.router.route(evt));
		expect(action.instruction).toContain("증분");
		expect(action.instruction).not.toContain("resolveReviewThread"); // operator-token lane gated
	});
});

describe("parseCommand / mentionsBot", () => {
	const aliases = ["gajae", "가재"];
	test("recognizes commands with and without @, case-insensitive", () => {
		expect(parseCommand("@gajae review", aliases)).toEqual({ cmd: "review", args: "" });
		expect(parseCommand("GAJAE Summary now", aliases)).toEqual({ cmd: "summary", args: "now" });
		expect(parseCommand("가재 리뷰", aliases)).toEqual({ cmd: "review", args: "" });
		expect(parseCommand("가재 learn 룰은 룰이다", aliases)).toEqual({ cmd: "learn", args: "룰은 룰이다" });
	});
	test("non-commands return null", () => {
		expect(parseCommand("@gajae 안녕", aliases)).toBeNull();
		expect(parseCommand("reviews are nice", aliases)).toBeNull();
		expect(parseCommand("", aliases)).toBeNull();
	});
	test("mentionsBot matches any alias", () => {
		expect(mentionsBot("hey @gajae look", aliases)).toBe(true);
		expect(mentionsBot("가재야 고마워", aliases)).toBe(true);
		expect(mentionsBot("nothing here", aliases)).toBe(false);
	});
});

describe("parseMinimalYaml", () => {
	test("scalars, booleans, ints, inline and block lists", () => {
		const doc = parseMinimalYaml(
			[
				"# comment",
				"enabled: true",
				"max_comments: 5",
				'tone: "친절하게"',
				"ignore_paths: [dist/, gen/]",
				"reviewers:",
				"  - alice",
				'  - "bob"',
			].join("\n"),
		);
		expect(doc.enabled).toBe(true);
		expect(doc.max_comments).toBe(5);
		expect(doc.tone).toBe("친절하게");
		expect(doc.ignore_paths).toEqual(["dist/", "gen/"]);
		expect(doc.reviewers).toEqual(["alice", "bob"]);
	});

	test("list of maps with continuation keys (path_instructions)", () => {
		const doc = parseMinimalYaml(
			[
				"path_instructions:",
				'  - path: "src/api/**"',
				"    instructions: REST 규칙 검사",
				'  - path: "**/*.sql"',
				"    instructions: 인덱스 확인",
			].join("\n"),
		);
		expect(doc.path_instructions).toEqual([
			{ path: "src/api/**", instructions: "REST 규칙 검사" },
			{ path: "**/*.sql", instructions: "인덱스 확인" },
		]);
	});
});
