/**
 * The review-session sandbox contract: sessions that consume untrusted PR
 * content must expose only the narrow tool surface, and every instruction
 * must stay executable under the restricted "workflow" bash profile (no
 * pipes, redirects, command substitution, or `$VAR` expansion).
 */
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import type { GithubReviewConfig } from "../src/github-review/config";
import {
	buildReview,
	closeLineFor,
	fixInstr,
	forceReviewInstr,
	type InstructionContext,
	resolveInstr,
	summaryInstr,
} from "../src/github-review/instructions";
import { REVIEW_SESSION_TOOLS, reviewSessionOptions } from "../src/github-review/runner";

function config(overrides: Partial<GithubReviewConfig> = {}): GithubReviewConfig {
	return {
		appId: "1",
		installationId: "2",
		privateKeyPath: "/nonexistent.pem",
		webhookSecret: "s",
		botLogin: "gajae-code",
		botAliases: ["gajae"],
		botDisplayName: "가재",
		markerPrefix: "gajae",
		checkName: "리뷰",
		host: "127.0.0.1",
		port: 0,
		webhookPath: "/wh",
		maxInflight: 4,
		turnTimeoutMinutes: 45,
		cwd: os.tmpdir(),
		dataDir: os.tmpdir(),
		ignoreRepos: [],
		allowedAssociations: ["OWNER"],
		learnAssociations: ["OWNER"],
		sessionBashPrefixes: ["gh pr", "gh api", "gjc github-review", "gitleaks"],
		repoConfigFile: ".gjc-review.yml",
		inflightStaleSeconds: 1200,
		sweepIntervalSeconds: 0,
		sweepStaleMinutes: 10,
		postCommand: "gjc github-review gh",
		completeCommand: "gjc github-review complete",
		localWebhookUrl: "http://127.0.0.1:0/wh",
		apiBase: "https://api.github.invalid",
		...overrides,
	};
}

const ctx: InstructionContext = {
	postCmd: "gjc github-review gh",
	completeCmd: "gjc github-review complete",
	botLogin: "gajae-code",
	markerPrefix: "gajae",
	botDisplayName: "가재",
	mention: "@gajae",
	ignoreRepos: [],
};

describe("reviewSessionOptions", () => {
	test("narrow tool surface: no edit/task/discovery, workflow-restricted bash", () => {
		const opts = reviewSessionOptions(config());
		expect(opts.toolNames).toEqual([...REVIEW_SESSION_TOOLS]);
		expect(opts.toolNames).not.toContain("edit");
		expect(opts.toolNames).not.toContain("task");
		expect(opts.bashRestrictionProfile).toBe("workflow");
		expect(opts.bashAllowedPrefixes).toEqual(["gh pr", "gh api", "gjc github-review", "gitleaks"]);
		expect(opts.discoverableToolAllowedNames).toEqual([]);
	});

	test("prefixes are copied, not aliased; modelPattern passes through", () => {
		const cfg = config({ modelPattern: "opus" });
		const opts = reviewSessionOptions(cfg);
		expect(opts.modelPattern).toBe("opus");
		opts.bashAllowedPrefixes.push("rm");
		expect(cfg.sessionBashPrefixes).not.toContain("rm");
		expect(reviewSessionOptions(config()).modelPattern).toBeUndefined();
	});
});

describe("instructions are restricted-shell safe", () => {
	const samples = [
		buildReview(ctx, "acme/web", 7, "abc1234", { closeLine: closeLineFor(ctx, "acme/web", 7, "abc1234") }),
		buildReview(ctx, "acme/web", 7, "abc1234", { incremental: true, baseSha: "000111" }),
		forceReviewInstr(ctx, "acme/web", 7),
		fixInstr(ctx, "acme/web", 7, "널 체크 고쳐줘"),
		resolveInstr(ctx, "acme/web", 7),
		summaryInstr(ctx, "acme/web", 7),
	];

	test("no command substitution or shell-variable usage anywhere", () => {
		for (const instruction of samples) {
			// The ban-rule prose may MENTION `$( )`/`$VAR`; actual usage shapes must not appear.
			expect(instruction).not.toContain("=$(");
			expect(instruction).not.toContain("$(gh");
			expect(instruction).not.toMatch(/\$(SHA|CID|B)\b/);
		}
	});

	test("sha sentinel renders as <SHA> literal-replacement instruction", () => {
		const forced = forceReviewInstr(ctx, "acme/web", 7);
		expect(forced).toContain("<SHA>");
		expect(forced).toContain("리터럴");
		expect(forced).not.toContain("SHA=$(");
	});
});
