import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	decideObservationRetry,
	localRollbackCommands,
	observeWithRetry,
	planAtomicPushRollback,
	pushReleaseRefsAtomically,
	ReleaseObservationError,
	RELEASE_OBSERVATION_ATTEMPTS,
	releaseObservationRetryDelayMs,
	reconcileAtomicPushFailure,
} from "./release";

const originalCwd = process.cwd();
const tempRoots: string[] = [];

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await $`git -c user.email=release-test@gajae.local -c user.name=release-test ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

interface Fixture {
	root: string;
	origin: string;
	work: string;
	preReleaseCommit: string;
}

async function releaseFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-release-retry-"));
	tempRoots.push(root);
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "work");
	await git(root, ["init", "--bare", "-b", "main", origin]);
	await git(root, ["clone", origin, work]);
	await Bun.write(path.join(work, "file.txt"), "before release\n");
	await git(work, ["add", "file.txt"]);
	await git(work, ["commit", "-m", "pre-release commit"]);
	await git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const preReleaseCommit = (await git(work, ["rev-parse", "HEAD"])).trim();
	// The release transaction: version/changelog commit plus the release tag.
	await Bun.write(path.join(work, "file.txt"), "release bump\n");
	await git(work, ["add", "file.txt"]);
	await git(work, ["commit", "-m", "chore: bump version to 9.9.9"]);
	await git(work, ["tag", "--no-sign", "v9.9.9"]);
	return { root, origin, work, preReleaseCommit };
}

describe("atomic push rollback plan", () => {
	test("maps a version and pre-release commit to the tag and reset target", () => {
		const plan = planAtomicPushRollback("9.9.9", "a".repeat(40));
		expect(plan.tag).toBe("v9.9.9");
		expect(plan.preReleaseCommit).toBe("a".repeat(40));
	});

	test("rejects non-stable versions and malformed commits", () => {
		expect(() => planAtomicPushRollback("9.9.9-rc.1", "a".repeat(40))).toThrow("exact stable");
		expect(() => planAtomicPushRollback("9.9.9", "not-a-sha")).toThrow("pre-release commit");
	});
});

describe("rejected atomic push recovery", () => {
	test("preserves the complete local release state with idempotent guidance on rejection", async () => {
		const { origin, work, preReleaseCommit } = await releaseFixture();

		// A concurrent main update makes the atomic push reject.
		const other = path.join(path.dirname(work), "other");
		await git(path.dirname(work), ["clone", origin, other]);
		await Bun.write(path.join(other, "other.txt"), "concurrent\n");
		await git(other, ["add", "other.txt"]);
		await git(other, ["commit", "-m", "concurrent main update"]);
		await git(other, ["push", "origin", "HEAD:refs/heads/main"]);

		process.chdir(work);
		const failure = await pushReleaseRefsAtomically("9.9.9").then(
			() => { throw new Error("expected the ambiguous push to throw"); },
			(error: unknown) => String(error),
		);
		// Guidance carries the guarded, per-artifact rollback commands.
		expect(failure).toContain("ambiguous remote outcome");
		expect(failure).toContain("git show-ref --verify --quiet refs/tags/v9.9.9 && git tag --delete v9.9.9");
		expect(failure).toContain(`git reset --hard ${preReleaseCommit}`);

		// Nothing was rolled back: the tag and the release commit are intact,
		// and the tree is clean, so the operator can reconcile by hand.
		const head = (await git(work, ["rev-parse", "HEAD"])).trim();
		expect(head).not.toBe(preReleaseCommit);
		const tagCheck = await $`git show-ref --verify --quiet refs/tags/v9.9.9`.cwd(work).quiet().nothrow();
		expect(tagCheck.exitCode).toBe(0);
		const status = (await git(work, ["status", "--porcelain"])).trim();
		expect(status).toBe("");
		// Nothing reached origin.
		const remoteTag = await $`git ls-remote --tags origin refs/tags/v9.9.9`.cwd(work).quiet().nothrow();
		expect(remoteTag.stdout.toString().trim()).toBe("");
	});

	test("pushes main and the tag atomically when nothing rejects them", async () => {
		const { work, preReleaseCommit } = await releaseFixture();

		process.chdir(work);
		await pushReleaseRefsAtomically("9.9.9");

		const releaseCommit = (await git(work, ["rev-parse", "HEAD"])).trim();
		expect(releaseCommit).not.toBe(preReleaseCommit);
		const remoteMain = (await git(work, ["ls-remote", "origin", "refs/heads/main"])).split("\t")[0]?.trim();
		expect(remoteMain).toBe(releaseCommit);
		const remoteTag = (await git(work, ["ls-remote", "origin", "refs/tags/v9.9.9"])).split("\t")[0]?.trim();
		expect(remoteTag).toBe(releaseCommit);
	});
});

describe("ambiguous atomic push failure reconciliation", () => {
	const sourceCommit = "d".repeat(40);
	const preMain = "e".repeat(40);

	test("a committed transaction with a failed push result reconciles as success", () => {
		const disposition = reconcileAtomicPushFailure("v9.9.9", {
			sourceCommit,
			prePushMain: preMain,
			prePushTag: "",
			remoteReachable: true,
			postPushMain: sourceCommit,
			postPushTag: sourceCommit,
		});
		expect(disposition.kind).toBe("committed");
		expect(disposition.note).toContain("no local state was rolled back");
	});

	test("baseline-equal snapshots are ambiguous and preserve local state (accepted-then-restored regression)", () => {
		// The refs may have committed and been restored before the re-query; a
		// snapshot match is not durable proof of rejection, so nothing is rolled
		// back automatically.
		const disposition = reconcileAtomicPushFailure("v9.9.9", {
			sourceCommit,
			prePushMain: preMain,
			prePushTag: "",
			remoteReachable: true,
			postPushMain: preMain,
			postPushTag: "",
		});
		expect(disposition.kind).toBe("preserve");
		expect(disposition.note).toContain("does not PROVE rejection");
		expect(disposition.note).toContain("preserved untouched");
	});

	test("a partially moved remote preserves all local state", () => {
		const disposition = reconcileAtomicPushFailure("v9.9.9", {
			sourceCommit,
			prePushMain: preMain,
			prePushTag: "",
			remoteReachable: true,
			postPushMain: sourceCommit,
			postPushTag: "",
		});
		expect(disposition.kind).toBe("preserve");
		expect(disposition.note).toContain("PARTIALLY");
		expect(disposition.note).toContain("preserved untouched");
		expect(disposition.note).toContain("Do not retry blindly");
	});

	test("an unreachable remote preserves all local state", () => {
		const disposition = reconcileAtomicPushFailure("v9.9.9", {
			sourceCommit,
			prePushMain: preMain,
			prePushTag: "",
			remoteReachable: false,
		});
		expect(disposition.kind).toBe("preserve");
		expect(disposition.note).toContain("could not be re-queried");
		expect(disposition.note).toContain("do NOT roll back");
	});
});

describe("idempotent per-outcome rollback guidance", () => {
	const releaseCommit = "f".repeat(40);
	const preReleaseCommit = "0".repeat(40);

	test("emits only the commands for the artifacts that still exist", () => {
		expect(localRollbackCommands("v9.9.9", releaseCommit, preReleaseCommit, { tagPresent: false, onReleaseCommit: true }))
			.toEqual([`test "$(git rev-parse HEAD)" = "${releaseCommit}" && git reset --hard ${preReleaseCommit}`]);
		expect(localRollbackCommands("v9.9.9", releaseCommit, preReleaseCommit, { tagPresent: true, onReleaseCommit: false }))
			.toEqual(["git show-ref --verify --quiet refs/tags/v9.9.9 && git tag --delete v9.9.9"]);
		expect(localRollbackCommands("v9.9.9", releaseCommit, preReleaseCommit, { tagPresent: false, onReleaseCommit: false }))
			.toEqual([]);
	});
});

describe("accepted remote transaction with a client-side failed push", () => {
	test("reconciles as success and keeps the local release state", async () => {
		const { work, preReleaseCommit } = await releaseFixture();

		// A git shim that performs the real atomic push but reports failure,
		// simulating a transport error after the remote committed.
		const shimDir = `${work}/.shim`;
		await fs.mkdir(shimDir);
		const realGit = (await $`which git`.quiet().text()).trim();
		await Bun.write(`${shimDir}/git`, `#!/bin/sh\nif [ "$1" = "-c" ]; then :; fi\nfor arg in "$@"; do if [ "$arg" = "--atomic" ]; then "${realGit}" "$@"; code=$?; if [ $code -eq 0 ]; then exit 5; else exit $code; fi; fi; done\nexec "${realGit}" "$@"\n`);
		await fs.chmod(`${shimDir}/git`, 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = `${shimDir}:${originalPath}`;
		try {
			process.chdir(work);
			await pushReleaseRefsAtomically("9.9.9");
		} finally {
			process.env.PATH = originalPath;
		}

		// Success: no rollback happened — HEAD is still the release commit and
		// the tag still exists, and the remote carries both refs.
		const head = (await git(work, ["rev-parse", "HEAD"])).trim();
		expect(head).not.toBe(preReleaseCommit);
		const tagCheck = await $`git show-ref --verify --quiet refs/tags/v9.9.9`.cwd(work).quiet().nothrow();
		expect(tagCheck.exitCode).toBe(0);
		const remoteTag = (await git(work, ["ls-remote", "origin", "refs/tags/v9.9.9"])).split("\t")[0]?.trim();
		expect(remoteTag).toBe(head);
	});
});

describe("post-push CI observation retry policy", () => {
	test("backs off exponentially from 2s and holds a 30s ceiling", () => {
		expect([1, 2, 3, 4, 5, 6].map(releaseObservationRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
	});

	test("rejects a non-positive or fractional attempt instead of inventing a delay", () => {
		expect(() => releaseObservationRetryDelayMs(0)).toThrow("positive integer");
		expect(() => releaseObservationRetryDelayMs(-1)).toThrow("positive integer");
		expect(() => releaseObservationRetryDelayMs(1.5)).toThrow("positive integer");
		expect(() => decideObservationRetry(0)).toThrow("positive integer");
	});

	test("retries every attempt before the budget and fails only on exhaustion", () => {
		for (let attempt = 1; attempt < RELEASE_OBSERVATION_ATTEMPTS; attempt++) {
			expect(decideObservationRetry(attempt)).toEqual({ action: "retry", delayMs: releaseObservationRetryDelayMs(attempt) });
		}
		expect(decideObservationRetry(RELEASE_OBSERVATION_ATTEMPTS)).toEqual({ action: "fail" });
		expect(decideObservationRetry(RELEASE_OBSERVATION_ATTEMPTS + 1)).toEqual({ action: "fail" });
	});

	test("spends a bounded wall-clock budget so a broken watch still terminates", () => {
		let total = 0;
		for (let attempt = 1; attempt < RELEASE_OBSERVATION_ATTEMPTS; attempt++) {
			const decision = decideObservationRetry(attempt);
			if (decision.action === "retry") total += decision.delayMs;
		}
		expect(total).toBeGreaterThanOrEqual(60_000);
		expect(total).toBeLessThanOrEqual(300_000);
	});
});

describe("observation command classification", () => {
	const noSleep = () => Promise.resolve();
	const zeroExitCommand = () => Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });

	test("classifies a zero exit with unusable output as an observation failure, not a verdict", async () => {
		let attempts = 0;
		let caught: unknown;
		try {
			await observeWithRetry(
				"probe",
				zeroExitCommand,
				() => {
					attempts++;
					throw new Error("Unexpected end of JSON input");
				},
				noSleep,
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ReleaseObservationError);
		expect(attempts).toBe(RELEASE_OBSERVATION_ATTEMPTS);
		expect((caught as ReleaseObservationError).message).toContain("failed 8 times: unusable response: Unexpected end of JSON input");
	});

	test("retries a truncated response within the same bounded budget and recovers", async () => {
		let attempts = 0;
		const command = () => Promise.resolve({ exitCode: 0, stdout: Buffer.from("[]"), stderr: Buffer.alloc(0) });
		const delays: number[] = [];
		const result = await observeWithRetry(
			"probe",
			command,
			stdout => {
				attempts++;
				if (attempts === 1) throw new Error("Cannot parse CI run query");
				return JSON.parse(stdout) as unknown[];
			},
			ms => {
				delays.push(ms);
				return Promise.resolve();
			},
		);
		expect(result).toEqual([]);
		expect(attempts).toBe(2);
		expect(delays).toEqual([releaseObservationRetryDelayMs(1)]);
	});

	test("reports the malformed-output reason, not a silent success or failure", async () => {
		const command = () => Promise.resolve({ exitCode: 0, stdout: Buffer.from("not json"), stderr: Buffer.alloc(0) });
		try {
			await observeWithRetry("probe", command, () => {
				throw new Error("did not return an array");
			}, noSleep);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(ReleaseObservationError);
			expect((error as ReleaseObservationError).message).toContain("unusable response: did not return an array");
		}
	});
});
