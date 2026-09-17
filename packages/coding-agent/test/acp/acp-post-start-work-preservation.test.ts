/**
 * Issue #5664: a long-running turn died ~1h in with a post-start terminal carrying
 * `retryability: "transient"` / `providerCode: "server_is_overloaded"`, and two things went wrong
 * at once:
 *
 *   1. ~1h of UNCOMMITTED worktree edits were stranded. The failure is terminal by design — the
 *      #5574 gates refuse to re-run a turn that already executed a tool, because a re-submit is a
 *      new independent `turn.prompt` that would repeat the user's side effects — so nothing was
 *      ever going to recover the turn. But nothing snapshotted the work either.
 *   2. The operator saw `Internal error: Provider failure after execution started.`, which reads
 *      as "your task failed" when the bounded classification says the upstream provider fell over.
 *
 * #5018 (`agent-session.ts` `isBareDefault*Overload`) admits replay only for a content-free
 * attempt; #5477 added phase/category diagnostics only; #5625 put `retryability` on the wire as
 * explicitly advisory ("nothing in this repo's retry paths consults it"). So this payload reached
 * `#settlePrompt` with every recovery path correctly closed and no preservation at all.
 *
 * These pin the non-destructive terminal: the work is snapshotted before `error` is reported, the
 * snapshot's location is stated, and the wording names the upstream provider. None of them relax
 * a retry gate.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpPromptFailureError, acpRequestFailure } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import {
	type PostStartPreservation,
	postStartOperatorMessage,
	preservePostStartWork,
} from "../../src/modes/acp/post-start-preservation";
import { failedPromptOutcome } from "../../src/sdk/prompt-failure";

function git(ws: string, args: string[]): string {
	return execFileSync("git", args, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** The exact #5664 rejection, built through the same builder `terminalOutcome` uses. */
function overloadFailure(preservation?: PostStartPreservation): AcpPromptFailureError {
	return new AcpPromptFailureError(
		failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode: "server_is_overloaded",
			phase: "post_start",
			evidence: {},
		}),
		preservation,
	);
}

function wireData(error: unknown): Record<string, unknown> {
	const failure = acpRequestFailure(error);
	expect(failure).toBeInstanceOf(RequestError);
	return (failure as RequestError).data as Record<string, unknown>;
}

let ws: string;

beforeEach(async () => {
	ws = await mkdtemp(path.join(tmpdir(), "gjc-5664-"));
	git(ws, ["init", "-q"]);
	git(ws, ["config", "user.email", "t@t"]);
	git(ws, ["config", "user.name", "t"]);
	git(ws, ["config", "commit.gpgsign", "false"]);
	await writeFile(path.join(ws, "src.ts"), "export const v = 1;\n");
	git(ws, ["add", "."]);
	git(ws, ["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
	await rm(ws, { recursive: true, force: true });
});

describe("post-start terminal preserves the worktree before reporting failure (issue #5664)", () => {
	it("snapshots an hour of uncommitted edits into a recoverable stash WITHOUT mutating the worktree", async () => {
		// The #5664 turn ran ~13 steps including `apply_patch`: tracked edits plus new files.
		await writeFile(path.join(ws, "src.ts"), "export const v = 2; // an hour of work\n");
		await writeFile(path.join(ws, "new-module.ts"), "export const added = true;\n");
		const before = git(ws, ["status", "--porcelain"]);

		const preservation = preservePostStartWork(ws);

		expect(preservation).toBeDefined();
		expect(preservation?.stashRef).toMatch(/^[0-9a-f]{7,64}$/);
		expect(preservation?.snapshotComplete).toBe(true);
		// Non-destructive: never resets, never cleans, never commits. The edits are still on disk
		// exactly as the turn left them.
		expect(await readFile(path.join(ws, "src.ts"), "utf8")).toBe("export const v = 2; // an hour of work\n");
		expect(await readFile(path.join(ws, "new-module.ts"), "utf8")).toBe("export const added = true;\n");
		expect(git(ws, ["status", "--porcelain"])).toBe(before);
		// And the snapshot is genuinely recoverable after the worktree is swept.
		expect(git(ws, ["stash", "list"])).toContain("harness-vanish-snapshot");
		expect(git(ws, ["rev-parse", "stash@{0}"]).trim()).toBe(preservation?.stashRef ?? "<none>");
		expect(git(ws, ["show", `${preservation?.stashRef}:src.ts`])).toBe("export const v = 2; // an hour of work\n");
	});

	it("does not stash-spam a clean tree", () => {
		expect(preservePostStartWork(ws)).toBeUndefined();
		expect(git(ws, ["stash", "list"]).trim()).toBe("");
	});

	it("is fail-safe: preservation throwing or the path being unusable never changes the outcome", () => {
		const thrower = (): never => {
			throw new Error("git is gone");
		};
		expect(() => preservePostStartWork(ws, thrower)).not.toThrow();
		expect(preservePostStartWork(ws, thrower)).toBeUndefined();
		// Not a git repo, and no path at all.
		expect(preservePostStartWork(path.join(tmpdir(), "gjc-5664-absent-dir"))).toBeUndefined();
		expect(preservePostStartWork(undefined)).toBeUndefined();
		expect(preservePostStartWork("")).toBeUndefined();
	});
});

describe("post-start terminal wording names the upstream provider (issue #5664)", () => {
	it("tells the operator the provider failed and where the work went", async () => {
		await writeFile(path.join(ws, "src.ts"), "export const v = 2;\n");
		const preservation = preservePostStartWork(ws);
		const data = wireData(overloadFailure(preservation));

		// The classification that was already on the wire is unchanged.
		expect(data).toMatchObject({
			code: "prompt_failed",
			phase: "post_start",
			category: "provider_transport",
			retryability: "transient",
			providerCode: "server_is_overloaded",
		});
		// The defect: `details` alone reads as "your task failed". It stays exactly as it is —
		// pinned ACP core-v1 conformance asserts on it — and the operator wording arrives beside it.
		expect(data.details).toBe("Provider failure after execution started.");
		expect(typeof data.operatorMessage).toBe("string");
		const operator = String(data.operatorMessage);
		expect(operator).toContain("Upstream provider failure");
		expect(operator).toContain("server_is_overloaded");
		// A snapshot nobody can find is not a fix: the ref is stated where the operator reads it.
		expect(operator).toContain(preservation?.stashRef ?? "<none>");
		expect(data.preservedStashRef).toBe(preservation?.stashRef);
	});

	it("keeps -32603 and the redacted message for the prompt-failure class", () => {
		const failure = acpRequestFailure(overloadFailure({ stashRef: "a".repeat(40), snapshotComplete: true }));

		expect((failure as RequestError).code).toBe(-32603);
		expect((failure as Error).message).toBe("Internal error: Provider failure after execution started.");
	});

	it("builds the wording only from bounded safe tokens, never from provider text", () => {
		const leak = "Request failed: 503 overloaded for user@example.com";
		const failure = new AcpPromptFailureError(
			failedPromptOutcome({
				code: "prompt_failed",
				provenance: "agent_failed",
				providerCode: leak,
				phase: "post_start",
				evidence: {},
			}),
			{ stashRef: "not-a-hex-oid; rm -rf /", snapshotComplete: true },
		);
		const serialized = JSON.stringify(acpRequestFailure(failure));

		expect(serialized).not.toContain("user@example.com");
		// The ref is interpolated into wire-bound text, so the hex-oid rule is enforced where it
		// reaches the wire and not only where it is captured.
		expect(serialized).not.toContain("rm -rf");
		expect(wireData(failure)).not.toHaveProperty("preservedStashRef");
		// An unbounded provider code is not a classifier, so it never selects `provider_transport`
		// and never reaches the wording.
		expect(wireData(failure)).not.toHaveProperty("providerCode");
	});

	it("says nothing extra when there is nothing an operator would not already know", () => {
		// A submission-phase agent-runtime rejection ran nothing and stranded nothing. Its payload
		// must stay byte-identical to before this change.
		const data = wireData(
			new AcpPromptFailureError(
				failedPromptOutcome({ code: "prompt_failed", provenance: "agent_failed", evidence: {} }),
			),
		);

		expect(data).toEqual({
			code: "prompt_failed",
			details: "Prompt submission failed.",
			phase: "submission",
			category: "agent_runtime",
			retryability: "terminal",
		});
	});

	it("reports an incomplete snapshot instead of implying the work is safe", () => {
		const message = postStartOperatorMessage({
			category: "provider_transport",
			providerCode: "server_is_overloaded",
			preservation: { snapshotComplete: false },
		});

		expect(message).toContain("no recoverable snapshot ref is available");
		expect(message).toContain("do not discard this worktree");
	});

	it("preserves work for a non-transport post-start fatal too, without claiming a provider problem (issue #5615)", () => {
		// #5615's payload is a bare `prompt_failed` — `agent_runtime`, `retryability: "terminal"` —
		// and it also ended `exit 4 (NO_COMMITS)`. Preservation is scoped to the PHASE, so it covers
		// that failure; the upstream-provider wording is gated on the category, so it does not.
		const message = postStartOperatorMessage({
			category: "agent_runtime",
			preservation: { stashRef: "b".repeat(40), snapshotComplete: true },
		});

		expect(message).toContain("The turn ended after execution had already started.");
		expect(message).not.toContain("Upstream provider failure");
		expect(message).toContain("b".repeat(40));
	});
});
