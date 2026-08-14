import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { canonicalDiffSha256, parseGhPrCreate, parsePrVerdict, validatePrContract } from "./verify-pr-verdict";

const base = "a".repeat(40);
const head = "b".repeat(40);
const digest = "c".repeat(64);
const approved = `gajae.pr-review-verdict.v1 merge-approved sha256:${digest} reviewer:architect reviewer-id:review-agent evidence:bun test scripts/verify-pr-verdict.test.ts`;

function validInput(overrides: Partial<Parameters<typeof validatePrContract>[0]> = {}) {
	return {
		body: `## GJC verdict\n\n${approved}\n`,
		baseRef: "dev",
		baseSha: base,
		headSha: head,
		authorLogin: "author",
		computedDiffSha256: digest,
		baseIsAncestor: true,
		fastGatePassed: true,
		requireMergeApproved: true,
		authenticatedReviewerLogin: "review-agent",
		authenticatedReviewHeadSha: head,
		...overrides,
	};
}

describe("parsePrVerdict", () => {
	test("accepts exactly one strict verdict line", () => {
		expect(parsePrVerdict(approved)).toEqual({
			verdict: {
				verdict: "merge-approved",
				diffSha256: digest,
				reviewerRole: "architect",
				reviewerId: "review-agent",
				evidence: "bun test scripts/verify-pr-verdict.test.ts",
			},
			diagnostics: [],
		});
	});

	test("fails closed for missing, duplicate, and malformed verdicts", () => {
		expect(parsePrVerdict("no verdict").diagnostics[0]).toContain("exactly one");
		expect(parsePrVerdict(`${approved}\n${approved}`).diagnostics[0]).toContain("contains 2");
		expect(parsePrVerdict(approved.replace("sha256:", "hash:")).diagnostics[0]).toContain("Malformed");
		expect(parsePrVerdict(approved.replace(" reviewer-id:review-agent", "")).diagnostics[0]).toContain("Malformed");
	});
});

describe("validatePrContract", () => {
	test("accepts exact-head independently approved contract", () => {
		expect(validatePrContract(validInput())).toMatchObject({ ok: true, diagnostics: [] });
	});

	test("reports base, ancestry, digest, fast-gate, and self-review failures together", () => {
		const result = validatePrContract(validInput({
			baseRef: "main",
			baseIsAncestor: false,
			computedDiffSha256: "d".repeat(64),
			fastGatePassed: false,
			authorLogin: "review-agent",
		}));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(5);
		expect(result.diagnostics.join("\n")).toContain("base must be dev");
		expect(result.diagnostics.join("\n")).toContain("does not contain immutable event base");
		expect(result.diagnostics.join("\n")).toContain("is stale");
		expect(result.diagnostics.join("\n")).toContain("fast gate failed");
		expect(result.diagnostics.join("\n")).toContain("cannot be self-approved");
	});

	test("local preflight permits blocking verdicts but server merge gate rejects them", () => {
		const body = approved.replace("merge-approved", "needs-human");
		expect(validatePrContract(validInput({ body, requireMergeApproved: false })).ok).toBe(true);
		expect(validatePrContract(validInput({ body, requireMergeApproved: true })).diagnostics[0]).toContain("intentionally blocks merge");
	});

	test("server merge approval requires an authenticated exact-head GitHub review", () => {
		expect(validatePrContract(validInput({ authenticatedReviewerLogin: undefined })).diagnostics.join("\n")).toContain("not backed by an authenticated");
		expect(validatePrContract(validInput({ authenticatedReviewHeadSha: "d".repeat(40) })).diagnostics.join("\n")).toContain("must target exact PR head");
	});

	test("rejects invalid event hashes", () => {
		const result = validatePrContract(validInput({ baseSha: "HEAD", headSha: "head", computedDiffSha256: "sha" }));
		expect(result.diagnostics.join("\n")).toContain("40-hex");
		expect(result.diagnostics.join("\n")).toContain("lowercase SHA-256");
	});
});

describe("parseGhPrCreate", () => {
	test("extracts body and base flags without executing the command", () => {
		expect(parseGhPrCreate("gh pr create --base dev --body-file /tmp/pr.md --title x")).toEqual({ base: "dev", bodyFile: "/tmp/pr.md" });
		expect(parseGhPrCreate("env X=1 gh pr create -B dev -b 'body text'")).toEqual({ base: "dev", body: "body text" });
	});

	test("ignores unrelated commands and fails closed for compound gh commands", () => {
		expect(parseGhPrCreate("git status")).toBeNull();
		expect(parseGhPrCreate("git status && gh pr create --body x")).toEqual({});
	});
});

test("canonicalDiffSha256 hashes exact bytes", () => {
	expect(canonicalDiffSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("server approval requires reviewer repository authority", async () => {
	const source = await Bun.file(new URL("./verify-pr-verdict.ts", import.meta.url)).text();
	expect(source).toContain("/collaborators/${encodeURIComponent(reviewerId)}/permission");
	expect(source).toContain('["admin", "maintain", "write"]');
});

test("hook keeps repository root separate from nested invocation cwd", async () => {
	const hook = await Bun.file(new URL("../docs/examples/gjc-hooks/pre/bash.ts", import.meta.url)).text();
	expect(hook).toContain('"--repo", repositoryRoot, "--invocation-cwd", invocationCwd');
});

test("preflight preserves missing body-file diagnostics", async () => {
	const temp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-pr-missing-body-"));
	try {
		const script = url.fileURLToPath(new URL("./verify-pr-verdict.ts", import.meta.url));
		const child = Bun.spawn([process.execPath, script, "--preflight-command", "gh pr create --base dev --body-file missing.md", "--repo", temp, "--trusted-root", temp, "--invocation-cwd", temp], { stdout: "pipe", stderr: "pipe" });
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain(`Could not read PR body file ${path.join(temp, "missing.md")}`);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

test("workflow is trusted-default-branch-controlled, read-only, exact-head, and invokes only base code", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	expect(workflow).toContain("pull_request_target:");
	expect(workflow).toContain("pull_request_review:");
	expect(workflow).toContain("types: [submitted, edited, dismissed]");
	expect(workflow).not.toContain("if: ${{ false }}");
	expect(workflow).not.toMatch(/^\s+pull_request:\s*$/mu);
	expect(workflow).toContain("permissions:\n  contents: read\n  pull-requests: read");
	expect(workflow).toContain("name: PR contract");
	expect(workflow).toContain("name: Validate exact-head PR contract");
	expect(workflow).toContain("repository: ${{ github.event.pull_request.head.repo.full_name }}");
	expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
	expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
	expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
	expect(workflow).toContain("unset BUN_OPTIONS");
	expect(workflow).toContain("empty_bunfig=\"$RUNNER_TEMP/gjc-pr-contract-empty-bunfig.toml\"");
	expect(workflow).toContain('if [[ ! -f "$trusted_root/scripts/verify-pr-verdict.ts" ]]');
	expect(workflow).toContain("predates the trusted validator; Dev CI PR contract bootstrap remains authoritative");
	expect(workflow).toMatch(/if \[\[ ! -f "\$trusted_root\/scripts\/verify-pr-verdict\.ts" \]\]; then[\s\S]*?exit 0[\s\S]*?bun --no-env-file/u);
	expect(workflow).not.toContain('! -f "$repo_root/scripts/verify-pr-verdict.ts"');
	expect(workflow).toContain("cd \"$trusted_root\"");
	expect(workflow).toContain('bun --no-env-file --config="$empty_bunfig" "$trusted_root/scripts/verify-pr-verdict.ts"');
	expect(workflow).toContain('--event "$GITHUB_EVENT_PATH" --repo "$repo_root" --trusted-root "$trusted_root"');
	expect(workflow).not.toContain("pr-head/scripts/verify-pr-verdict.ts");
	expect(workflow).not.toContain("secrets.");
	expect(workflow).not.toContain("actions/cache");
	expect(workflow).not.toContain("upload-artifact");
	expect(workflow).not.toContain("download-artifact");
	expect(workflow).not.toContain("continue-on-error");
});

test("trusted Bun launch cannot load an untrusted repo bunfig preload", async () => {
	const root = await Bun.file(new URL("../package.json", import.meta.url)).json() as { packageManager: string };
	expect(root.packageManager).toBe("bun@1.3.14");
	const temp = await fs.mkdtemp("/tmp/gjc-pr-bun-isolation-");
	try {
		const trusted = path.join(temp, "trusted");
		const untrusted = path.join(temp, "untrusted");
		const sentinel = path.join(temp, "preload-ran");
		await fs.mkdir(trusted, { recursive: true });
		await fs.mkdir(untrusted, { recursive: true });
		await Bun.write(path.join(untrusted, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
		await Bun.write(path.join(untrusted, "preload.ts"), `await Bun.write(${JSON.stringify(sentinel)}, "pwned");\n`);
		await Bun.write(path.join(trusted, "empty.toml"), "# trusted empty Bun configuration\n");
		await Bun.write(path.join(trusted, "probe.ts"), 'console.log("trusted-probe");\n');
		const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${path.join(trusted, "empty.toml")}`, path.join(trusted, "probe.ts")], {
			cwd: untrusted,
			env: { ...process.env, BUN_OPTIONS: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("trusted-probe");
		expect(await Bun.file(sentinel).exists()).toBe(false);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

test("a PR-authored workflow cannot become the trusted enforcement authority", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	const spoofedHeadWorkflow = workflow.replace(
		'"$trusted_root/scripts/verify-pr-verdict.ts"',
		'"$repo_root/scripts/verify-pr-verdict.ts"',
	);
	// GitHub loads pull_request_target workflow bytes from the default branch, not from this PR diff.
	expect(workflow).toContain("pull_request_target:");
	expect(spoofedHeadWorkflow).toContain('"$repo_root/scripts/verify-pr-verdict.ts"');
	expect(workflow).not.toContain('"$repo_root/scripts/verify-pr-verdict.ts"');
});

test("template pins reviewer identity and exact diff digest", async () => {
	const template = await Bun.file(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url)).text();
	expect(template).toContain("reviewer-id:<identity>");
	expect(template).toContain("sha256:<exact-base...head-diff-hash>");
});

test("dev CI carries immutable inline first-landing bootstrap validation", async () => {
	const workflow = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	expect(workflow).toContain("pr-contract-bootstrap:");
	expect(workflow).toContain("name: PR contract bootstrap");
	expect(workflow).not.toContain("pull_request_review:");
	expect(workflow).toContain("if: ${{ github.event_name == 'pull_request' }}");
	expect(workflow).toContain("bun --no-env-file --config=\"$empty_bunfig\" -e '");
	expect(workflow).toContain("repository: ${{ github.event.pull_request.head.repo.full_name }}");
	expect(workflow).toContain("bun scripts/verify-gjc-state-writers.ts --fail --root .");
	expect(workflow).toContain("Expected exactly one verdict line");
	expect(workflow).toContain("effective exact-head approval");
	expect(workflow).toContain("lacks repository review authority");
	expect(workflow).toContain("/collaborators/${encodeURIComponent(reviewerId)}/permission");
	expect(workflow).toContain('review.state !== "COMMENTED" && review.commit_id === head');
	expect(workflow).not.toContain("pr-head/scripts/verify-pr-verdict.ts");
});

test("review events cannot launch or cancel the affected Dev CI pipeline", async () => {
	const devCi = await Bun.file(new URL("../.github/workflows/dev-ci.yml", import.meta.url)).text();
	const prContract = await Bun.file(new URL("../.github/workflows/pr-validation.yml", import.meta.url)).text();
	expect(devCi).not.toContain("pull_request_review:");
	expect(prContract).toContain("pull_request_review:");
	expect(prContract).toContain("types: [submitted, edited, dismissed]");
	expect(prContract).not.toContain("affected-plan");
	expect(prContract).not.toContain("evidence producer");
});
