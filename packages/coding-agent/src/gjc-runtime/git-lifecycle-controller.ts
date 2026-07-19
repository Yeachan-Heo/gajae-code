import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	acquireLifecycleLock,
	appendLifecycleEvent,
	createLaneName,
	isCleanupEligible,
	type LaneRecord,
	LifecycleError,
	ownershipMatches,
	readLaneRecord,
	WorkType,
	writeLaneRecord,
} from "./git-lifecycle";

export type LanePolicyMode = "pr-only" | "local-controlled-merge";
export interface RequiredGate {
	name: string;
	app: string;
}
export interface LanePolicy {
	version: 1;
	mode: LanePolicyMode;
	remote: string;
	base: string;
	worktreeRoot: string;
	allowedAutoMergeTypes: WorkType[];
	requiredGates: RequiredGate[];
	retentionHours: number;
	forbiddenPathPatterns: string[];
}
export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export type CommandRunner = (argv: string[], cwd: string) => Promise<CommandResult>;
export interface PullRequest {
	number: number;
	url?: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	isCrossRepository: boolean;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	baseRefOid: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	checks?: Array<{ name: string; app?: string; conclusion?: string | null; headSha: string }>;
	mergedAt?: string;
	mergeCommit?: string;
	remoteBranchDeleted?: boolean;
}
export interface SquashMergeEvidence {
	method: "SQUASH";
	matchHeadCommit: string;
	expectedBaseCommit: string;
}
export interface GithubAdapter {
	findPullRequest(head: string, base: string): Promise<PullRequest | undefined>;
	createPullRequest(head: string, base: string, title: string): Promise<PullRequest>;
	getPullRequest(number: number): Promise<PullRequest | undefined>;
	squashMergePullRequest(
		number: number,
		input: { matchHeadCommit: string; expectedBaseCommit: string },
	): Promise<SquashMergeEvidence>;
}
export interface ControllerOptions {
	cwd: string;
	runner?: CommandRunner;
	github?: GithubAdapter;
	now?: () => Date;
}
export interface StartInput {
	laneId: string;
	type: WorkType;
	scope: string;
	purpose: string;
	agent: string;
	sessionId: string;
	realm?: "windows" | "wsl";
}
export interface LaneStatus {
	policy?: LanePolicy;
	record?: ManagedLaneRecord;
}
export interface ManagedLaneRecord extends LaneRecord {
	remote?: string;
	base?: string;
	baseSha?: string;
	headSha?: string;
	prNumber?: number;
	prUrl?: string;
	mergedAt?: string;
	mergeCommit?: string;
	mergedHeadSha?: string;
	mergedBaseSha?: string;
	remoteBranchDeleted?: boolean;
	leaseExpiresAt?: string;
	gitCommonDir?: string;
}

const policyFile = "policy.json";
const policyRoot = (commonDir: string) => path.join(commonDir, "gjc", "lifecycle", "v1");
const policyPath = (commonDir: string) => path.join(policyRoot(commonDir), policyFile);
const nowIso = (now: () => Date) => now().toISOString();

export function defaultCommandRunner(argv: string[], cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	return Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
		([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }),
	);
}

export class GitLifecycleController {
	readonly cwd: string;
	readonly runner: CommandRunner;
	readonly github?: GithubAdapter;
	readonly now: () => Date;
	constructor(options: ControllerOptions) {
		this.cwd = options.cwd;
		this.runner = options.runner ?? defaultCommandRunner;
		this.github = options.github;
		this.now = options.now ?? (() => new Date());
	}

	async configure(
		input: Omit<LanePolicy, "version" | "retentionHours"> & { retentionHours?: number },
	): Promise<LanePolicy> {
		if (input.mode !== "pr-only" && input.mode !== "local-controlled-merge")
			throw new LifecycleError("policy mode must be pr-only or local-controlled-merge");
		if (!input.remote || !input.base || !input.worktreeRoot)
			throw new LifecycleError("remote, base, and worktree root are required");
		const commonDir = await this.commonDir();
		const worktreeRoot = await this.assertSafeWorktreeRoot(input.worktreeRoot);
		const policy: LanePolicy = {
			version: 1,
			...input,
			worktreeRoot,
			retentionHours: input.retentionHours ?? 24,
			allowedAutoMergeTypes: [...input.allowedAutoMergeTypes],
			requiredGates: input.requiredGates.map(gate => ({ ...gate })),
			forbiddenPathPatterns: [...input.forbiddenPathPatterns],
		};
		if (policy.mode === "local-controlled-merge" && policy.requiredGates.length === 0)
			throw new LifecycleError("local-controlled-merge requires at least one required gate");
		if (!isLanePolicy(policy)) throw new LifecycleError("lane policy has an invalid shape");
		await fs.mkdir(policyRoot(commonDir), { recursive: true });
		const destination = policyPath(commonDir);
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, `${JSON.stringify(policy, null, "\t")}\n`, "utf8");
			await fs.rename(temporary, destination);
		} finally {
			await fs.rm(temporary, { force: true });
		}
		return policy;
	}

	async status(laneId?: string): Promise<LaneStatus> {
		const commonDir = await this.commonDir();
		return {
			policy: await this.readPolicy(commonDir),
			record: laneId ? ((await readLaneRecord(commonDir, laneId)) as ManagedLaneRecord | undefined) : undefined,
		};
	}

	async start(input: StartInput): Promise<ManagedLaneRecord> {
		const commonDir = await this.commonDir();
		const policy = await this.requirePolicy(commonDir);
		const lock = await acquireLifecycleLock(commonDir, input.laneId);
		let record: ManagedLaneRecord | undefined;
		let worktreeMutationAttempted = false;
		try {
			if (await readLaneRecord(commonDir, input.laneId)) throw new LifecycleError("lane id already exists");
			await this.git(["fetch", "--no-tags", policy.remote, policy.base]);
			const baseSha = await this.gitText(["rev-parse", `${policy.remote}/${policy.base}`]);
			const existingBranches = (await this.gitText(["branch", "--format=%(refname:short)"]))
				.split("\n")
				.filter(Boolean);
			const existingWorktreeTokens = (await this.gitText(["worktree", "list", "--porcelain"]))
				.split("\n")
				.filter(line => line.startsWith("worktree "))
				.map(line => path.basename(line.slice("worktree ".length)));
			const name = createLaneName({ ...input, id: input.laneId, existingBranches, existingWorktreeTokens });
			const repoName = path.basename(await this.gitText(["rev-parse", "--show-toplevel"]));
			const worktreePath = path.join(policy.worktreeRoot, repoName, name.worktreeToken);
			if (await exists(worktreePath)) throw new LifecycleError("managed worktree path already exists");
			const ownership = {
				repositoryId: await this.repositoryId(),
				realm: input.realm ?? "windows",
				branch: name.branch,
				worktreeToken: name.worktreeToken,
				worktreePath,
				agent: input.agent,
				sessionId: input.sessionId,
			};
			const at = nowIso(this.now);
			record = {
				version: 1,
				laneId: input.laneId,
				state: "planned",
				createdAt: at,
				updatedAt: at,
				...ownership,
				remote: policy.remote,
				base: policy.base,
				baseSha,
				headSha: baseSha,
				gitCommonDir: commonDir,
			};
			await writeLaneRecord(commonDir, record);
			await this.event(commonDir, record, "planned", { baseSha });
			worktreeMutationAttempted = true;
			await this.assertSafeWorktreeRoot(policy.worktreeRoot);
			await this.git(["worktree", "add", "-b", name.branch, worktreePath, baseSha]);
			record.worktreeGitDir = path.resolve(
				worktreePath,
				await this.gitText(["rev-parse", "--git-dir"], worktreePath),
			);
			record.worktreeOwnershipToken = randomUUID();
			await fs.writeFile(path.join(record.worktreeGitDir, "gjc-lane-owner"), record.worktreeOwnershipToken, {
				encoding: "utf8",
				flag: "wx",
			});
			record.state = "active";
			record.updatedAt = nowIso(this.now);
			await writeLaneRecord(commonDir, record);
			await this.event(commonDir, record, "started", { baseSha });
			return record;
		} catch (error: unknown) {
			if (record) {
				record.state = "blocked";
				record.updatedAt = nowIso(this.now);
				await writeLaneRecord(commonDir, record);
				await this.event(commonDir, record, "start_failed", {
					worktreeMutationAttempted,
					error: error instanceof Error ? error.message : "unknown error",
				});
			}
			throw error;
		} finally {
			await lock.release();
		}
	}

	async pr(laneId: string, title?: string): Promise<ManagedLaneRecord> {
		const commonDir = await this.commonDir();
		const lock = await acquireLifecycleLock(commonDir, laneId);
		try {
			const policy = await this.requirePolicy(commonDir);
			const record = await this.requireRecord(commonDir, laneId);
			this.assertPolicyBinding(record, policy);
			this.assertNoActiveLease(record);
			await this.assertManagedWorktree(record, commonDir);
			const headSha = await this.gitText(["rev-parse", "HEAD"], record.worktreePath);
			await this.git(["push", policy.remote, `HEAD:refs/heads/${record.branch}`], record.worktreePath);
			const github = this.requireGithub();
			let pull = await github.findPullRequest(record.branch, policy.base);
			if (!pull) {
				try {
					pull = await github.createPullRequest(record.branch, policy.base, title ?? record.branch);
				} catch (error) {
					const raced = await github.findPullRequest(record.branch, policy.base);
					if (!raced) throw error;
					pull = raced;
				}
			}
			if (
				pull.isCrossRepository ||
				pull.headRefName !== record.branch ||
				pull.baseRefName !== policy.base ||
				pull.headRefOid !== headSha
			)
				throw new LifecycleError("pull request does not match managed same-repository head and base");
			Object.assign(record, {
				state: "pr_open",
				updatedAt: nowIso(this.now),
				headSha,
				prNumber: pull.number,
				prUrl: pull.url,
			});
			await writeLaneRecord(commonDir, record);
			await this.event(commonDir, record, "pr_opened", { prNumber: pull.number, headSha });
			return record;
		} finally {
			await lock.release();
		}
	}

	async reconcile(laneId: string): Promise<ManagedLaneRecord> {
		const commonDir = await this.commonDir();
		const lock = await acquireLifecycleLock(commonDir, laneId);
		try {
			const policy = await this.requirePolicy(commonDir);
			const record = await this.requireRecord(commonDir, laneId);
			this.assertPolicyBinding(record, policy);
			this.assertNoActiveLease(record);
			const pr = record.prNumber ? await this.requireGithub().getPullRequest(record.prNumber) : undefined;
			if (!pr) throw new LifecycleError("managed pull request is unavailable");
			if (pr.state === "MERGED") return this.recordMerged(commonDir, record, pr);
			if (pr.state === "CLOSED") {
				record.state = "closed_unmerged";
				record.updatedAt = nowIso(this.now);
				await writeLaneRecord(commonDir, record);
				await this.event(commonDir, record, "closed_unmerged");
				return record;
			}
			if (policy.mode === "pr-only") return record;
			await this.assertManagedWorktree(record, commonDir);
			await this.assertMergeEligible(record, policy, pr);
			const merge = await this.requireGithub().squashMergePullRequest(pr.number, {
				matchHeadCommit: pr.headRefOid,
				expectedBaseCommit: pr.baseRefOid,
			});
			if (
				merge.method !== "SQUASH" ||
				merge.matchHeadCommit !== pr.headRefOid ||
				merge.expectedBaseCommit !== pr.baseRefOid
			)
				throw new LifecycleError("provider did not confirm squash merge at the requested head and base");
			record.state = "merge_requested";
			record.updatedAt = nowIso(this.now);
			await writeLaneRecord(commonDir, record);
			await this.event(commonDir, record, "merge_requested", { prNumber: pr.number, headSha: pr.headRefOid });
			return record;
		} finally {
			await lock.release();
		}
	}

	async gc(laneId: string): Promise<ManagedLaneRecord> {
		const commonDir = await this.commonDir();
		const lock = await acquireLifecycleLock(commonDir, laneId);
		try {
			const policy = await this.requirePolicy(commonDir);
			const record = await this.requireRecord(commonDir, laneId);
			this.assertPolicyBinding(record, policy);
			const pr = record.prNumber ? await this.requireGithub().getPullRequest(record.prNumber) : undefined;
			if (pr?.state !== "MERGED" || !record.mergeCommit || !record.mergedHeadSha || !pr.mergedAt)
				throw new LifecycleError("positive merged pull request tuple is required for cleanup");
			if (pr.mergeCommit !== record.mergeCommit || pr.headRefOid !== record.mergedHeadSha)
				throw new LifecycleError("merged pull request immutable tuple no longer matches the record");
			if (this.now().getTime() - Date.parse(pr.mergedAt) < policy.retentionHours * 3600000)
				throw new LifecycleError("retention period has not elapsed");
			if (record.leaseOwner) throw new LifecycleError("lane has an active lease");
			record.cleanupEvidence ??= {};
			const evidence = record.cleanupEvidence;
			if (record.state !== "gc_eligible" && record.state !== "cleanup_blocked") {
				evidence.mergeCommit = record.mergeCommit;
				evidence.retentionApprovedAt ??= nowIso(this.now);
				evidence.explicitCleanupRequestedAt ??= nowIso(this.now);
				evidence.gcApprovedAt ??= nowIso(this.now);
			}
			record.state = "gc_eligible";
			await writeLaneRecord(commonDir, record);
			if (!isCleanupEligible(record, record) || !ownershipMatches(record, record))
				throw new LifecycleError("cleanup eligibility gate is not satisfied");

			const worktreePresent = await exists(record.worktreePath);
			if (worktreePresent) {
				await this.assertManagedWorktree(record, commonDir);
				await this.assertClean(record.worktreePath);
				if ((await this.gitText(["rev-parse", "HEAD"], record.worktreePath)) !== record.headSha)
					throw new LifecycleError("worktree head no longer matches the recorded head");
			} else if (evidence.worktreeRemoveIntent?.path !== record.worktreePath || !evidence.worktreeRemoveIntent.at) {
				throw new LifecycleError("worktree is absent without a matching recorded removal intent");
			}

			const localRef = `refs/heads/${record.branch}`;
			const localRefPresent = (await this.gitExit(["rev-parse", "--verify", localRef])) === 0;
			if (localRefPresent) {
				if ((await this.gitText(["rev-parse", localRef])) !== record.headSha)
					throw new LifecycleError("local branch no longer matches the recorded head");
			} else if (
				evidence.localRefDeleteIntent?.ref !== localRef ||
				evidence.localRefDeleteIntent.headSha !== record.headSha
			) {
				throw new LifecycleError("local branch is absent without a matching recorded deletion intent");
			}

			await this.git(["fetch", "--no-tags", policy.remote, policy.base]);
			const base = await this.gitText(["rev-parse", `${policy.remote}/${policy.base}`]);
			if ((await this.gitExit(["merge-base", "--is-ancestor", record.mergeCommit, base])) !== 0)
				throw new LifecycleError("recorded merge commit is not reachable from fresh target");

			const remoteRef = await this.gitTextOptional([
				"ls-remote",
				"--heads",
				policy.remote,
				`refs/heads/${record.branch}`,
			]);
			if (remoteRef && remoteRef.split(/\s+/)[0] !== record.headSha)
				throw new LifecycleError("remote feature branch advanced beyond the recorded head");

			try {
				if (remoteRef) {
					evidence.remoteDeleteIntent ??= { headSha: record.headSha!, at: nowIso(this.now) };
					await writeLaneRecord(commonDir, record);
					await this.git([
						"push",
						`--force-with-lease=refs/heads/${record.branch}:${record.headSha}`,
						policy.remote,
						`:refs/heads/${record.branch}`,
					]);
					if (await this.gitTextOptional(["ls-remote", "--heads", policy.remote, `refs/heads/${record.branch}`]))
						throw new LifecycleError("remote feature branch still exists after leased deletion");
				}
				evidence.remoteBranchDeletedAt ??= nowIso(this.now);
				await writeLaneRecord(commonDir, record);

				if (worktreePresent) {
					evidence.worktreeRemoveIntent ??= { path: record.worktreePath, at: nowIso(this.now) };
					await writeLaneRecord(commonDir, record);
					await this.git(["worktree", "remove", record.worktreePath]);
				}
				evidence.worktreeRemovedAt ??= nowIso(this.now);
				await writeLaneRecord(commonDir, record);

				if (localRefPresent) {
					evidence.localRefDeleteIntent ??= { ref: localRef, headSha: record.headSha!, at: nowIso(this.now) };
					await writeLaneRecord(commonDir, record);
					await this.git(["update-ref", "-d", localRef, record.headSha!]);
				}
				evidence.localRefDeletedAt ??= nowIso(this.now);
				record.state = "cleaned";
				record.updatedAt = nowIso(this.now);
				record.remoteBranchDeleted = true;
				await writeLaneRecord(commonDir, record);
				await this.event(commonDir, record, "cleanup_completed", { remoteBranchDeleted: true });
				return record;
			} catch (error) {
				record.state = "cleanup_blocked";
				evidence.cleanupBlockedAt = nowIso(this.now);
				evidence.cleanupBlockedReason = error instanceof Error ? error.message : "unknown error";
				record.updatedAt = nowIso(this.now);
				await writeLaneRecord(commonDir, record);
				throw error;
			}
		} finally {
			await lock.release();
		}
	}

	private async recordMerged(
		commonDir: string,
		record: ManagedLaneRecord,
		pr: PullRequest,
	): Promise<ManagedLaneRecord> {
		if (!pr.mergeCommit || !pr.mergedAt || !pr.headRefOid || !pr.baseRefOid || pr.headRefOid !== record.headSha)
			throw new LifecycleError("merged pull request is missing its immutable merge tuple or recorded head");
		record.state = "retention";
		record.updatedAt = nowIso(this.now);
		record.mergedAt = pr.mergedAt;
		record.mergeCommit = pr.mergeCommit;
		record.mergedHeadSha = pr.headRefOid;
		record.mergedBaseSha = pr.baseRefOid;
		record.remoteBranchDeleted = pr.remoteBranchDeleted === true;
		await writeLaneRecord(commonDir, record);
		await this.event(commonDir, record, "merged", {
			mergeCommit: pr.mergeCommit,
			headSha: pr.headRefOid,
			baseSha: pr.baseRefOid,
		});
		return record;
	}
	private async assertMergeEligible(record: ManagedLaneRecord, policy: LanePolicy, pr: PullRequest): Promise<void> {
		if (
			pr.state !== "OPEN" ||
			pr.isDraft ||
			pr.isCrossRepository ||
			pr.headRefName !== record.branch ||
			pr.baseRefName !== policy.base
		)
			throw new LifecycleError("pull request is not an open same-repository managed pull request");
		await this.git(["fetch", "--no-tags", policy.remote, policy.base]);
		const head = await this.gitText(["rev-parse", "HEAD"], record.worktreePath);
		const base = await this.gitText(["rev-parse", `${policy.remote}/${policy.base}`]);
		if (head !== record.headSha || pr.headRefOid !== head || pr.baseRefOid !== base || pr.mergeable !== "MERGEABLE")
			throw new LifecycleError("pull request head, base, or mergeability is not current");
		if (!policy.allowedAutoMergeTypes.includes(record.branch.split("/", 1)[0] as WorkType))
			throw new LifecycleError("work type is not allowed for controlled merge");
		if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED")
			throw new LifecycleError("pull request has unresolved review decisions");
		for (const gate of policy.requiredGates) {
			if (
				!pr.checks?.some(
					check =>
						check.name === gate.name &&
						check.app === gate.app &&
						check.headSha === head &&
						check.conclusion === "SUCCESS",
				)
			)
				throw new LifecycleError(`required check gate is missing or unsuccessful: ${gate.name}/${gate.app}`);
		}
		const changed = (await this.gitText(["diff", "--name-only", `${base}...${head}`], record.worktreePath))
			.split("\n")
			.filter(Boolean);
		for (const pattern of policy.forbiddenPathPatterns)
			if (changed.some(file => glob(pattern, file))) throw new LifecycleError(`forbidden path changed: ${pattern}`);
	}
	private async assertManagedWorktree(record: ManagedLaneRecord, controllerCommonDir: string): Promise<void> {
		if (!record.gitCommonDir || path.resolve(record.gitCommonDir) !== path.resolve(controllerCommonDir))
			throw new LifecycleError("lane record common git directory does not match the controller");
		const top = await this.gitText(["rev-parse", "--show-toplevel"], record.worktreePath);
		if (path.resolve(top) !== path.resolve(record.worktreePath))
			throw new LifecycleError("lane worktree ownership does not match");
		const worktreeCommonDir = path.resolve(
			record.worktreePath,
			await this.gitText(["rev-parse", "--git-common-dir"], record.worktreePath),
		);
		if (worktreeCommonDir !== path.resolve(controllerCommonDir))
			throw new LifecycleError("lane worktree common git directory does not match the controller");
		if (!record.worktreeGitDir) throw new LifecycleError("lane worktree administrative identity is missing");
		const worktreeGitDir = path.resolve(
			record.worktreePath,
			await this.gitText(["rev-parse", "--git-dir"], record.worktreePath),
		);
		if (worktreeGitDir !== path.resolve(record.worktreeGitDir))
			throw new LifecycleError("lane worktree administrative identity does not match");
		if (
			!record.worktreeOwnershipToken ||
			(await fs.readFile(path.join(worktreeGitDir, "gjc-lane-owner"), "utf8")) !== record.worktreeOwnershipToken
		)
			throw new LifecycleError("lane worktree ownership nonce does not match");
		const branch = await this.gitText(["branch", "--show-current"], record.worktreePath);
		if (branch !== record.branch) throw new LifecycleError("lane branch ownership does not match");
	}
	private async assertClean(cwd: string): Promise<void> {
		if ((await this.gitText(["status", "--porcelain", "--untracked-files=all"], cwd)).length)
			throw new LifecycleError("worktree is dirty");
	}
	private requireGithub(): GithubAdapter {
		if (!this.github) throw new LifecycleError("GitHub capability is unavailable");
		return this.github;
	}
	private async commonDir(): Promise<string> {
		return path.resolve(this.cwd, await this.gitText(["rev-parse", "--git-common-dir"]));
	}
	private async repositoryId(): Promise<string> {
		return this.gitText(["config", "--get", "remote.origin.url"]).catch(() =>
			this.gitText(["rev-parse", "--show-toplevel"]),
		);
	}
	private async assertSafeWorktreeRoot(root: string): Promise<string> {
		const canonicalRoot = await canonicalPath(root);
		const protectedRoots = [
			await canonicalPath(await this.gitText(["rev-parse", "--show-toplevel"])),
			...(await this.gitText(["worktree", "list", "--porcelain"]))
				.split("\n")
				.filter(line => line.startsWith("worktree "))
				.map(line => line.slice("worktree ".length)),
		];
		for (const protectedRoot of protectedRoots) {
			const canonicalProtected = await canonicalPath(protectedRoot);
			if (isInside(canonicalRoot, canonicalProtected))
				throw new LifecycleError("worktree root must be external to every repository worktree");
		}
		return canonicalRoot;
	}
	private async readPolicy(commonDir: string): Promise<LanePolicy | undefined> {
		try {
			const policy: unknown = JSON.parse(await fs.readFile(policyPath(commonDir), "utf8"));
			if (!isLanePolicy(policy)) throw new LifecycleError("lane policy has an invalid shape");
			return policy;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	private async requirePolicy(commonDir: string): Promise<LanePolicy> {
		const policy = await this.readPolicy(commonDir);
		if (!policy) throw new LifecycleError("lane policy is not configured");
		return policy;
	}
	private async requireRecord(commonDir: string, laneId: string): Promise<ManagedLaneRecord> {
		const record = (await readLaneRecord(commonDir, laneId)) as ManagedLaneRecord | undefined;
		if (!record) throw new LifecycleError("lane record does not exist");
		return record;
	}
	private assertPolicyBinding(record: ManagedLaneRecord, policy: LanePolicy): void {
		if (!record.remote || !record.base || record.remote !== policy.remote || record.base !== policy.base)
			throw new LifecycleError("lane policy remote or base drifted from the immutable lane binding");
	}
	private assertNoActiveLease(record: ManagedLaneRecord): void {
		if (record.leaseOwner) throw new LifecycleError("lane has an active lease");
	}
	private async event(
		commonDir: string,
		record: ManagedLaneRecord,
		type: string,
		details?: Record<string, string | number | boolean | null>,
	): Promise<void> {
		await appendLifecycleEvent(commonDir, {
			version: 1,
			laneId: record.laneId,
			at: nowIso(this.now),
			type,
			state: record.state,
			details,
		});
	}
	private async git(argv: string[], cwd = this.cwd): Promise<void> {
		const result = await this.runner(["git", ...argv], cwd);
		if (result.exitCode !== 0) throw new LifecycleError(result.stderr.trim() || `git ${argv[0]} failed`);
	}
	private async gitText(argv: string[], cwd = this.cwd): Promise<string> {
		const result = await this.runner(["git", ...argv], cwd);
		if (result.exitCode !== 0) throw new LifecycleError(result.stderr.trim() || `git ${argv[0]} failed`);
		return result.stdout.trim();
	}
	private async gitTextOptional(argv: string[], cwd = this.cwd): Promise<string> {
		const result = await this.runner(["git", ...argv], cwd);
		if (result.exitCode !== 0) throw new LifecycleError(result.stderr.trim() || `git ${argv[0]} failed`);
		return result.stdout.trim();
	}
	private async gitExit(argv: string[], cwd = this.cwd): Promise<number> {
		return (await this.runner(["git", ...argv], cwd)).exitCode;
	}
}

function isLanePolicy(value: unknown): value is LanePolicy {
	if (typeof value !== "object" || value === null) return false;
	const policy = value as Partial<LanePolicy>;
	return (
		policy.version === 1 &&
		(policy.mode === "pr-only" || policy.mode === "local-controlled-merge") &&
		typeof policy.remote === "string" &&
		policy.remote.length > 0 &&
		typeof policy.base === "string" &&
		policy.base.length > 0 &&
		typeof policy.worktreeRoot === "string" &&
		policy.worktreeRoot.length > 0 &&
		Array.isArray(policy.allowedAutoMergeTypes) &&
		policy.allowedAutoMergeTypes.every(type => Object.values(WorkType).includes(type as WorkType)) &&
		Array.isArray(policy.requiredGates) &&
		policy.requiredGates.every(
			gate =>
				typeof gate === "object" &&
				gate !== null &&
				typeof gate.name === "string" &&
				gate.name.length > 0 &&
				typeof gate.app === "string" &&
				gate.app.length > 0,
		) &&
		typeof policy.retentionHours === "number" &&
		Number.isFinite(policy.retentionHours) &&
		policy.retentionHours >= 0 &&
		Array.isArray(policy.forbiddenPathPatterns) &&
		policy.forbiddenPathPatterns.every(entry => typeof entry === "string")
	);
}
function glob(pattern: string, value: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${escaped}$`).test(value);
}
async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}
function isInside(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function canonicalPath(target: string): Promise<string> {
	const resolved = path.resolve(target);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}
