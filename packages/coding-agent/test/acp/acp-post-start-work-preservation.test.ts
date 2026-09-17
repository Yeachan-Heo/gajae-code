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
		// NOT complete: `new-module.ts` is untracked, and `git stash create` snapshots tracked
		// content only, so the stash object cannot restore it. Reporting `true` here was the false
		// promise — it also suppressed the only warning that would have told the operator to keep
		// the worktree.
		expect(preservation?.snapshotComplete).toBe(false);
		expect(preservation?.untrackedNotCaptured).toBe(1);
		// Non-destructive: never resets, never cleans, never commits. The edits are still on disk
		// exactly as the turn left them.
		expect(await readFile(path.join(ws, "src.ts"), "utf8")).toBe("export const v = 2; // an hour of work\n");
		expect(await readFile(path.join(ws, "new-module.ts"), "utf8")).toBe("export const added = true;\n");
		expect(git(ws, ["status", "--porcelain"])).toBe(before);
		// And the snapshot is genuinely recoverable after the worktree is swept.
		expect(git(ws, ["stash", "list"])).toContain("gjc-post-start-snapshot");
		expect(git(ws, ["rev-parse", "stash@{0}"]).trim()).toBe(preservation?.stashRef ?? "<none>");
		expect(git(ws, ["show", `${preservation?.stashRef}:src.ts`])).toBe("export const v = 2; // an hour of work\n");
	});

	it("reports a verified clean tree as clean, and does not stash-spam it", () => {
		const preservation = preservePostStartWork(ws);

		expect(preservation.status).toBe("clean");
		expect(preservation.snapshotComplete).toBe(true);
		expect(preservation.stashRef).toBeUndefined();
		expect(git(ws, ["stash", "list"]).trim()).toBe("");
		// The original wording survives for the case it was always true for.
		expect(postStartOperatorMessage({ category: "agent_runtime", preservation })).toContain(
			"No uncommitted work was found to preserve.",
		);
	});

	// This is the load-bearing test for the whole "fix the promise, not the capture" decision. If
	// someone later switches the shared helper to `git stash push -u` semantics (which WOULD capture
	// untracked files, at the cost of mutating the worktree), the ground-truth assertion below fails
	// loudly instead of the report silently going back to over-claiming.
	it("proves untracked files are absent from the stash object, and reports that instead of promising them", async () => {
		await writeFile(path.join(ws, "src.ts"), "export const v = 2;\n");
		await writeFile(path.join(ws, "new-module.ts"), "export const added = true;\n");

		const preservation = preservePostStartWork(ws);
		const stashRef = preservation?.stashRef ?? "<none>";

		// GROUND TRUTH: the stash commit's tree holds the tracked edit and nothing else. `git stash
		// create` takes a MESSAGE, not flags, so there is no non-destructive `-u` that would change
		// this; real untracked capture needs `git stash push -u`, which mutates the worktree.
		const stashedPaths = git(ws, ["ls-tree", "-r", "--name-only", stashRef])
			.split("\n")
			.map(s => s.trim())
			.filter(Boolean);
		expect(stashedPaths).toContain("src.ts");
		expect(stashedPaths).not.toContain("new-module.ts");

		// The report must match that reality rather than the hopeful version of it.
		expect(preservation?.snapshotComplete).toBe(false);
		expect(preservation?.untrackedNotCaptured).toBe(1);

		const message = postStartOperatorMessage({
			category: "provider_transport",
			providerCode: "server_is_overloaded",
			preservation,
		});

		// The tracked half of the promise is true, so the recovery hint stays.
		expect(message).toContain(`git stash apply ${stashRef}`);
		// The untracked half is named, counted, and actionable.
		expect(message).toContain("1 new file(s) are NOT in that snapshot");
		expect(message).toContain("do not discard this worktree");
		// A count, never a path: this string crosses the wire and untracked paths are user-controlled.
		expect(message).not.toContain("new-module.ts");
	});

	it("keeps the plain recovery promise for a tracked-only dirty tree, where it is true", async () => {
		// The control case: no untracked files, so the stash really does hold everything. This proves
		// the fix reports the actual gap rather than blanket-marking every snapshot incomplete.
		await writeFile(path.join(ws, "src.ts"), "export const v = 2;\n");

		const preservation = preservePostStartWork(ws);

		expect(preservation?.snapshotComplete).toBe(true);
		expect(preservation?.untrackedNotCaptured).toBeUndefined();
		expect(git(ws, ["ls-tree", "-r", "--name-only", preservation?.stashRef ?? "<none>"])).toContain("src.ts");

		const message = postStartOperatorMessage({
			category: "provider_transport",
			providerCode: "server_is_overloaded",
			preservation,
		});

		expect(message).toContain(`git stash apply ${preservation?.stashRef}`);
		expect(message).not.toContain("NOT in that snapshot");
		expect(message).not.toContain("do not discard this worktree");
		expect(message).not.toContain("snapshot is incomplete");
	});

	// REGRESSION (round-3 review finding 2): the capture observed dirtiness, counted untracked
	// files, then stashed — with nothing checking the worktree held still in between. A file that
	// appeared mid-flight produced `snapshotComplete: true` plus a ref that cannot recover it, so the
	// operator was shown complete-recovery wording and a later sweep stranded the concurrent edit.
	it("downgrades a snapshot taken across a changing worktree, keeping the ref it did get", async () => {
		await writeFile(path.join(ws, "src.ts"), "export const v = 2;\n");
		// A real capture first, to borrow a genuine stash oid for the raced result.
		const settled = preservePostStartWork(ws);
		const realRef = settled.stashRef ?? "<none>";
		// The file that appeared between the untracked count and the stash. It exists on disk and is
		// absent from `realRef`'s tree, exactly as in the reported race.
		await writeFile(path.join(ws, "appeared-mid-capture.ts"), "export const late = true;\n");
		expect(git(ws, ["ls-tree", "-r", "--name-only", realRef])).not.toContain("appeared-mid-capture.ts");

		const raced = preservePostStartWork(ws, () => ({
			status: "preserved",
			stashRef: realRef,
			untrackedNotCaptured: 1,
			stable: false,
		}));

		// The ref survives — it genuinely recovers the tracked content it holds.
		expect(raced.stashRef).toBe(realRef);
		// But the snapshot is NOT complete, which is the whole finding.
		expect(raced.snapshotComplete).toBe(false);
		expect(raced.racedDuringCapture).toBe(true);

		const message = postStartOperatorMessage({ category: "provider_transport", preservation: raced });

		expect(message).toContain(`git stash apply ${realRef}`);
		expect(message).toContain("changed while it was being captured");
		expect(message).toContain("do not discard this worktree");
		// A boolean and a count cross the wire; the path never does.
		expect(message).not.toContain("appeared-mid-capture.ts");
	});

	it("still reports a stable capture as complete, with no race wording", async () => {
		// The control for the case above: without it, a blanket "always incomplete" regression passes.
		await writeFile(path.join(ws, "src.ts"), "export const v = 2;\n");

		const preservation = preservePostStartWork(ws);

		expect(preservation.status).toBe("preserved");
		expect(preservation.snapshotComplete).toBe(true);
		expect(preservation.racedDuringCapture).toBeUndefined();

		const message = postStartOperatorMessage({ category: "provider_transport", preservation });
		expect(message).not.toContain("changed while it was being captured");
		expect(message).not.toContain("do not discard this worktree");
	});

	it("treats an unverifiable or unstable re-read as unknown rather than clean", () => {
		// A `clean` verdict nobody re-confirmed is indistinguishable from "I did not look".
		for (const stable of [undefined, false, "true" as unknown as boolean, null as unknown as boolean])
			expect(preservePostStartWork(ws, () => ({ status: "clean", untrackedNotCaptured: 0, stable })).status).toBe(
				"unknown",
			);
		// And a capture that DID verify still reports clean.
		expect(preservePostStartWork(ws, () => ({ status: "clean", untrackedNotCaptured: 0, stable: true })).status).toBe(
			"clean",
		);
	});

	// REGRESSION (round-3 review finding 1): `#settlePrompt` leaves `preservation` undefined for any
	// failure whose phase is not `post_start`, so a submission-phase transport rejection reached the
	// wording with nothing captured — and was told its worktree had been checked and found empty.
	// No inspection ever happened. The base emitted no such sentence.
	it("asserts nothing about the worktree when no capture was attempted", () => {
		const message = postStartOperatorMessage({
			category: "provider_transport",
			providerCode: "server_is_overloaded",
		});

		expect(message).toContain("Upstream provider failure");
		expect(message).not.toContain("No uncommitted work was found to preserve.");
		// Nothing was inspected, so nothing is claimed in either direction.
		expect(message).not.toContain("do not discard this worktree");
		expect(message).not.toContain("could not be verified");
	});

	it("still says nothing was found for a capture that verified the tree is clean", () => {
		// The control for the case above: without it, deleting the sentence everywhere would pass.
		const message = postStartOperatorMessage({
			category: "provider_transport",
			providerCode: "server_is_overloaded",
			preservation: { status: "clean", snapshotComplete: true },
		});

		expect(message).toContain("No uncommitted work was found to preserve.");
	});

	it("reports the larger uncaptured count when files appear during the capture", () => {
		// The operator needs the number that covers what is actually missing from the snapshot.
		const raced = preservePostStartWork(ws, () => ({
			status: "preserved",
			stashRef: "d".repeat(40),
			untrackedNotCaptured: 3,
			stable: false,
		}));

		expect(raced.untrackedNotCaptured).toBe(3);
		expect(postStartOperatorMessage({ category: "provider_transport", preservation: raced })).toContain(
			"3 new file(s) are NOT in that snapshot",
		);
	});

	it("reads a malformed uncaptured count as zero rather than letting it reach the operator", () => {
		// `PostStartPreservation` is reachable with any value, so the count is bounded the same way
		// `safeStashRef` bounds the ref.
		for (const bad of [-1, 1.5, Number.NaN, "3" as unknown as number, Number.MAX_SAFE_INTEGER + 2])
			expect(
				postStartOperatorMessage({
					category: "provider_transport",
					preservation: {
						status: "preserved",
						stashRef: "c".repeat(40),
						snapshotComplete: true,
						untrackedNotCaptured: bad,
					},
				}),
			).not.toContain("NOT in that snapshot");
	});

	// REGRESSION (review finding 1): an uninspectable worktree used to return the same bare
	// `undefined` as a verified-clean one, so the operator was told "No uncommitted work was found
	// to preserve." for a tree nobody had managed to look at — and swept it.
	it("reports an uninspectable worktree as unknown, never as clean", () => {
		const thrower = (): never => {
			throw new Error("git is gone");
		};
		// Still fail-safe: it reports, it does not throw.
		expect(() => preservePostStartWork(ws, thrower)).not.toThrow();

		for (const [label, preservation] of [
			["capture threw", preservePostStartWork(ws, thrower)],
			["not a git repo", preservePostStartWork(path.join(tmpdir(), "gjc-5664-absent-dir"))],
			["no workspace", preservePostStartWork(undefined)],
			["empty workspace", preservePostStartWork("")],
		] as const) {
			expect({ label, status: preservation.status }).toEqual({ label, status: "unknown" });
			expect({ label, complete: preservation.snapshotComplete }).toEqual({ label, complete: false });
		}

		const message = postStartOperatorMessage({
			category: "agent_runtime",
			preservation: { status: "unknown", snapshotComplete: false },
		});

		// The exact conflation that was wrong: absence of evidence reported as evidence of absence.
		expect(message).not.toContain("No uncommitted work was found");
		expect(message).toContain("could not be verified or preserved");
		expect(message).toContain("do not discard this worktree");
	});

	// REGRESSION (review finding 2): the capture runs synchronously inside `#settlePrompt`, before
	// the rejection. A capture that hangs or overruns its budget must degrade to `unknown` rather
	// than delaying — or changing — the terminal outcome. Driven through the injected seam so this
	// asserts the RESULT and never races a wall clock.
	it("degrades to unknown when the capture exceeds its budget or the git call times out", () => {
		const timedOut = (): never => {
			// The shape `execFileSync` throws on a `timeout` overrun: SIGKILLed, string `code`.
			throw Object.assign(new Error("spawnSync git ETIMEDOUT"), {
				code: "ETIMEDOUT",
				signal: "SIGKILL",
				status: null,
			});
		};
		const bufferBlown = (): never => {
			throw Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS", status: null });
		};

		for (const [label, seam] of [
			["git timed out", timedOut],
			["output cap blown", bufferBlown],
			["budget overrun", () => ({ status: "unknown", untrackedNotCaptured: 0 }) as const],
		] as const) {
			const preservation = preservePostStartWork(ws, seam);
			expect({ label, status: preservation.status }).toEqual({ label, status: "unknown" });
			// A killed git is NOT evidence the tree was empty.
			expect({ label, complete: preservation.snapshotComplete }).toEqual({ label, complete: false });
		}
	});

	it("never reads untracked file contents, and still counts them", async () => {
		await writeFile(path.join(ws, "src.ts"), "export const v = 2;\n");
		await writeFile(path.join(ws, "secret-blob.ts"), "x".repeat(200_000));

		const preservation = preservePostStartWork(ws);

		expect(preservation.status).toBe("preserved");
		expect(preservation.untrackedNotCaptured).toBe(1);
		expect(preservation.snapshotComplete).toBe(false);

		const message = postStartOperatorMessage({ category: "provider_transport", preservation });
		// The count travels; the name and the contents never do.
		expect(message).toContain("1 new file(s) are NOT in that snapshot");
		expect(message).not.toContain("secret-blob.ts");
		expect(message).not.toContain("xxxx");
	});

	it("reads a malformed or missing status as unknown rather than clean", () => {
		// Mirrors the malformed-count case: this type is reachable with any value, and the
		// conservative default is the one that cannot cost an operator their work.
		for (const bad of [undefined, null, "CLEAN", "preserved ", 0, {}, "unknown"])
			expect(
				postStartOperatorMessage({
					category: "agent_runtime",
					preservation: { status: bad as never, snapshotComplete: true },
				}),
			).toContain("could not be verified or preserved");
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
		const failure = acpRequestFailure(
			overloadFailure({ status: "preserved", stashRef: "a".repeat(40), snapshotComplete: true }),
		);

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
			{ status: "preserved", stashRef: "not-a-hex-oid; rm -rf /", snapshotComplete: true },
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
			preservation: { status: "preserved", snapshotComplete: false },
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
			preservation: { status: "preserved", stashRef: "b".repeat(40), snapshotComplete: true },
		});

		expect(message).toContain("The turn ended after execution had already started.");
		expect(message).not.toContain("Upstream provider failure");
		expect(message).toContain("b".repeat(40));
	});
});
