import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultFinalizeChecks, ValidationObservationUncertainError } from "../src/harness-control-plane/finalize";
import {
	admitManagedTask,
	cancelManagedTasks,
	createManagedDomainBinding,
	currentManagedRevision,
	defineManagedTaskGraph,
	type ManagedDomainBinding,
	type ManagedTaskDefinition,
	managedIdentity,
	managedTaskDomainPath,
	reviseManagedTaskGraph,
	transactManagedTaskDomain,
} from "../src/sdk/broker/managed-task-dag";
import { verifyManagedTaskAttempt } from "../src/sdk/broker/managed-task-verification";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-verify-"));
	roots.push(root);
	await fs.mkdir(path.join(root, ".gjc"), { mode: 0o755 });
	const binding = await createManagedDomainBinding({
		controlRoot: root,
		agentDir: root,
		enrollmentId: "enrollment",
		worktrees: [root],
	});
	return { root, binding };
}

function node(root: string, command: string): ManagedTaskDefinition {
	const output = path.join(root, "result.txt");
	return {
		id: "a",
		task: "Write result",
		workspace: root,
		predecessors: [],
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "exists", command }],
		resources: [
			{ kind: "path", path: output, mode: "write", recursive: false, namespace: false },
			{ kind: "path", path: root, mode: "write", recursive: false, namespace: true },
		],
		artifacts: [{ path: output, role: "output", presence: "required" }],
	};
}

async function enrollClosed(binding: ManagedDomainBinding, definition: ManagedTaskDefinition) {
	await transactManagedTaskDomain(
		{ binding, expectedRevision: 0, assertNoManagedEvidence: async () => {} },
		async state => {
			await defineManagedTaskGraph(state, { id: "g", owner: "owner", nodes: [definition] });
		},
	);
	await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
		admitManagedTask(state, {
			graphId: "g",
			owner: "owner",
			nodeId: "a",
			attemptId: "attempt-a",
			native: { key: "a", identity: managedIdentity("native-a"), requestHash: managedIdentity({ task: "a" }) },
		}),
	);
	await transactManagedTaskDomain({ binding, expectedRevision: 2 }, async state => {
		state.graphs[0]!.attempts[0]!.worker = "closed";
	});
}

describe("managed verification (M4b)", () => {
	it("accepts a closed worker, retires the quiescent attempt, and replays the trusted receipt", async () => {
		const { root, binding } = await fixture();
		const output = path.join(root, "result.txt");
		await fs.writeFile(output, "produced");
		await enrollClosed(binding, node(root, "test -f result.txt"));
		const first = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(first.status).toBe("accepted");
		expect(first.started).toBe(true);
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{
				attempts: Array<{ accepted: { id: string; hash: string } | null; validation: string; retired: boolean }>;
			}>;
		};
		expect(domain.graphs[0]!.attempts[0]!.accepted).not.toBeNull();
		expect(domain.graphs[0]!.attempts[0]!.validation).toBe("finished");
		expect(domain.graphs[0]!.attempts[0]!.retired).toBe(true);
		const again = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(again.status).toBe("accepted");
		expect(again.started).toBe(false);
	});
	it("marks durable unknown when the runner throws ValidationObservationUncertainError", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "test -f result.txt"));
		const result = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					throw new ValidationObservationUncertainError(spec.command, root);
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(result).toMatchObject({ status: "unknown", started: true });
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{
				attempts: Array<{
					accepted: { id: string; hash: string } | null;
					validation: string;
					retired: boolean;
				}>;
			}>;
		};
		expect(domain.graphs[0]!.attempts[0]!.accepted).toBeNull();
		expect(domain.graphs[0]!.attempts[0]!.validation).toBe("unknown");
		expect(domain.graphs[0]!.attempts[0]!.retired).toBe(false);
	});
	it("reconciles a post-rename uncertain start to unknown without launching or retrying the validator", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "true"));
		let runs = 0;
		const runner = {
			runValidation: async (spec: { name: string; command: string }) => {
				runs += 1;
				return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
			},
			resolveCommit: async () => null,
			commitOnBranch: async () => false,
			prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
		};
		const rename = fs.rename;
		let injected = false;
		const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			const anchoredTarget = path.join(await fs.realpath(path.dirname(String(to))), path.basename(String(to)));
			if (!injected && anchoredTarget === managedTaskDomainPath(root)) {
				injected = true;
				throw new Error("simulated start publication acknowledgement loss");
			}
		});
		let first: Awaited<ReturnType<typeof verifyManagedTaskAttempt>>;
		try {
			first = await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner", runner });
		} finally {
			fault.mockRestore();
		}
		expect(injected).toBe(true);
		expect(first).toMatchObject({ status: "unknown", started: false });
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{
				attempts: Array<{
					validation: string;
					verificationExecution: { executionId: string } | null;
				}>;
			}>;
		};
		expect(domain.graphs[0]!.attempts[0]!.validation).toBe("unknown");
		expect(domain.graphs[0]!.attempts[0]!.verificationExecution).not.toBeNull();
		const again = await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner", runner });
		expect(again).toMatchObject({ status: "unknown", started: false });
		expect(runs).toBe(0);
	});
	it("returns unknown when a plain runner exception is durably recorded as unknown", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "true"));
		let runs = 0;
		const runner = {
			runValidation: async () => {
				runs += 1;
				throw new Error("runner crashed");
			},
			resolveCommit: async () => null,
			commitOnBranch: async () => false,
			prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
		};
		const result = await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner", runner });
		expect(result).toMatchObject({ status: "unknown", started: true });
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{
				attempts: Array<{ accepted: unknown; validation: string; retired: boolean }>;
			}>;
		};
		expect(domain.graphs[0]!.attempts[0]!.accepted).toBeNull();
		expect(domain.graphs[0]!.attempts[0]!.validation).toBe("unknown");
		expect(domain.graphs[0]!.attempts[0]!.retired).toBe(false);
		const again = await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner", runner });
		expect(again).toMatchObject({ status: "unknown", started: false });
		expect(runs).toBe(1);
	});
	it("returns the durably accepted result after post-rename acceptance uncertainty", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "true"));
		const rename = fs.rename;
		let injected = false;
		const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			const anchoredTarget = path.join(await fs.realpath(path.dirname(String(to))), path.basename(String(to)));
			if (!injected && anchoredTarget === managedTaskDomainPath(root)) {
				const persisted = JSON.parse(await fs.readFile(String(to), "utf8"));
				const attempt = persisted.graphs[0].attempts[0];
				if (attempt.validation === "finished" && attempt.accepted !== null) {
					injected = true;
					throw new Error("simulated acceptance acknowledgement loss");
				}
			}
		});
		let result: Awaited<ReturnType<typeof verifyManagedTaskAttempt>>;
		try {
			result = await verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: {
					runValidation: async spec => ({
						exactCommand: spec.command,
						cwd: root,
						exitStatus: 0,
						pass: true,
					}),
					resolveCommit: async () => null,
					commitOnBranch: async () => false,
					prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
				},
			});
		} finally {
			fault.mockRestore();
		}
		expect(injected).toBe(true);
		expect(result).toMatchObject({ status: "accepted", started: true });
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8"));
		expect(domain.graphs[0].attempts[0].validation).toBe("finished");
		expect(domain.graphs[0].attempts[0].accepted).not.toBeNull();
	});
	it("returns the durably failed result after post-rename failure uncertainty", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "false"));
		const rename = fs.rename;
		let injected = false;
		const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			const anchoredTarget = path.join(await fs.realpath(path.dirname(String(to))), path.basename(String(to)));
			if (!injected && anchoredTarget === managedTaskDomainPath(root)) {
				const persisted = JSON.parse(await fs.readFile(String(to), "utf8"));
				const attempt = persisted.graphs[0].attempts[0];
				if (attempt.validation === "finished" && attempt.fence === "failed") {
					injected = true;
					throw new Error("simulated failure acknowledgement loss");
				}
			}
		});
		let result: Awaited<ReturnType<typeof verifyManagedTaskAttempt>>;
		try {
			result = await verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: {
					runValidation: async spec => ({
						exactCommand: spec.command,
						cwd: root,
						exitStatus: 1,
						pass: false,
					}),
					resolveCommit: async () => null,
					commitOnBranch: async () => false,
					prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
				},
			});
		} finally {
			fault.mockRestore();
		}
		expect(injected).toBe(true);
		expect(result).toMatchObject({ status: "failed", started: true });
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8"));
		expect(domain.graphs[0].attempts[0].validation).toBe("finished");
		expect(domain.graphs[0].attempts[0].fence).toBe("failed");
		expect(domain.graphs[0].attempts[0].accepted).toBeNull();
	});

	it("rejects a failed validation and retires the quiescent attempt", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "exit 7"));
		const result = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(result.status).toBe("failed");
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{ attempts: Array<{ accepted: unknown; fence: string; retired: boolean; validation: string }> }>;
		};
		expect(domain.graphs[0]!.attempts[0]!.accepted).toBeNull();
		expect(domain.graphs[0]!.attempts[0]!.retired).toBe(true);
		expect(domain.graphs[0]!.attempts[0]!.fence).toBe("failed");
	});

	it("treats publication failure as unknown and starts no additional commands on repeat verify", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "true"));
		let runs = 0;
		const runner = {
			runValidation: async (spec: { name: string; command: string }) => {
				runs += 1;
				return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
			},
			resolveCommit: async () => null,
			commitOnBranch: async () => false,
			prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
		};
		const first = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				...runner,
				runValidation: async spec => {
					const observation = await runner.runValidation(spec);
					await fs.writeFile(managedTaskDomainPath(root), "{");
					return observation;
				},
			},
		});
		expect(first.status).toBe("unknown");
		expect(first.started).toBe(true);
		if (first.status === "unknown") expect(first.reason).toMatch(/verification unknown/);
		await expect(
			transactManagedTaskDomain(
				{ binding, expectedRevision: 0, assertNoManagedEvidence: async () => {} },
				async () => undefined,
			),
		).rejects.toThrow("corrupt authority");
		const again = await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner", runner });
		expect(again.status).toBe("unknown");
		expect(again.started).toBe(false);
		expect(runs).toBe(1);
	});

	it("observes an in-progressker without starting additional commands", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "true"));
		let runs = 0;
		await transactManagedTaskDomain({ binding, expectedRevision: 3 }, async state => {
			const attempt = state.graphs[0]!.attempts[0]!;
			attempt.worker = "closed";
			attempt.validation = "running";
			attempt.verificationExecution = {
				executionId: "exec-running",
				workspace: root,
				commands: [{ name: "exists", command: "true" }],
				observations: [],
				receipts: [],
			};
		});
		const again = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					runs += 1;
					return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(again.status).toBe("running");
		expect(again.started).toBe(false);
		expect(runs).toBe(0);
	});

	it("cancel fences acceptance even if a late runner would pass", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "true"));
		const result = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					await transactManagedTaskDomain(
						{
							binding,
							expectedRevision: await currentManagedRevision(binding),
						},
						async state => {
							cancelManagedTasks(state.graphs[0]!, ["a"]);
						},
					);
					return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(result.status).toBe("failed");
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{ attempts: Array<{ accepted: unknown; fence: string; retired: boolean; validation: string }> }>;
		};
		expect(domain.graphs[0]!.attempts[0]!.accepted).toBeNull();
		expect(domain.graphs[0]!.attempts[0]!.fence).toBe("canceled");
		expect(domain.graphs[0]!.attempts[0]!.validation).toBe("finished");
		expect(domain.graphs[0]!.attempts[0]!.retired).toBe(true);
	});
	it("captures recursive child inputs and refuses later input drift", async () => {
		const { root, binding } = await fixture();
		const tree = path.join(root, "src");
		await fs.mkdir(tree);
		await fs.writeFile(path.join(tree, "a.ts"), " const a = 1;\n");
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		const definition: ManagedTaskDefinition = {
			id: "a",
			task: "Write result",
			workspace: root,
			predecessors: [],
			criteriaIdentity: managedIdentity("criteria"),
			validations: [{ name: "exists", command: "test -f result.txt" }],
			resources: [
				{ kind: "path", path: tree, mode: "read", recursive: true, namespace: false },
				{ kind: "path", path: path.join(root, "result.txt"), mode: "write", recursive: false, namespace: false },
				{ kind: "path", path: root, mode: "write", recursive: false, namespace: true },
			],
			artifacts: [
				{ path: tree, role: "input", presence: "required" },
				{ path: path.join(root, "result.txt"), role: "output", presence: "required" },
			],
		};
		await enrollClosed(binding, definition);
		expect(
			await verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: defaultFinalizeChecks(root),
			}),
		).toMatchObject({ status: "accepted" });
		await fs.writeFile(path.join(tree, "a.ts"), "const a = 2;\n");
		const drifted = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(drifted).toMatchObject({
			status: "failed",
			started: false,
			reason: "managed-task: verification refused",
		});
	});
	it("accepts a child under declared Q", async () => {
		const { root, binding } = await fixture();
		const outDir = path.join(root, "out");
		const checks = path.join(root, ".checks");
		await fs.mkdir(outDir);
		await fs.mkdir(checks);
		await fs.writeFile(path.join(outDir, "built.txt"), "built");
		await fs.writeFile(path.join(checks, "report.json"), "{}");
		const definition: ManagedTaskDefinition = {
			id: "a",
			task: "Write result",
			workspace: root,
			predecessors: [],
			criteriaIdentity: managedIdentity("criteria"),
			validations: [{ name: "exists", command: "test -f out/built.txt" }],
			resources: [
				{ kind: "path", path: outDir, mode: "write", recursive: true, namespace: false },
				{ kind: "path", path: checks, mode: "write", recursive: true, namespace: false },
				{ kind: "path", path: root, mode: "write", recursive: false, namespace: true },
			],
			artifacts: [
				{ path: outDir, role: "output", presence: "required" },
				{ path: checks, role: "validation-output", presence: "optional" },
			],
		};
		await enrollClosed(binding, definition);
		const qChild = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					await fs.writeFile(path.join(checks, "nested.json"), "{}");
					return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(qChild.status).toBe("accepted");
	});
	it("refuses declared input mutation during the first validator execution", async () => {
		const { root, binding } = await fixture();
		const inputFile = path.join(root, "src", "a.ts");
		const outDir = path.join(root, "out");
		await fs.mkdir(path.join(root, "src"));
		await fs.mkdir(outDir);
		await fs.writeFile(inputFile, "const a = 1;\n");
		await fs.writeFile(path.join(outDir, "built.txt"), "built");
		const definition: ManagedTaskDefinition = {
			id: "a",
			task: "Write result",
			workspace: root,
			predecessors: [],
			criteriaIdentity: managedIdentity("criteria"),
			validations: [{ name: "exists", command: "test -f out/built.txt" }],
			resources: [
				{ kind: "path", path: path.join(root, "src"), mode: "read", recursive: true, namespace: false },
				{ kind: "path", path: outDir, mode: "write", recursive: true, namespace: false },
				{ kind: "path", path: root, mode: "write", recursive: false, namespace: true },
			],
			artifacts: [
				{ path: path.join(root, "src"), role: "input", presence: "required" },
				{ path: outDir, role: "output", presence: "required" },
			],
		};
		await enrollClosed(binding, definition);
		const drifted = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					await fs.writeFile(inputFile, "const a = 2;\n");
					return { exactCommand: spec.command, cwd: root, exitStatus: 0, pass: true };
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(drifted.status).toBe("failed");
		expect(drifted.started).toBe(true);
		expect(drifted).toMatchObject({ reason: "managed-task: verification refused" });
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{ attempts: Array<{ accepted: unknown; fence: string; validation: string }> }>;
		};
		expect(domain.graphs[0]!.attempts[0]!.accepted).toBeNull();
		expect(domain.graphs[0]!.attempts[0]!.validation).toBe("finished");
		expect(domain.graphs[0]!.attempts[0]!.fence).toBe("failed");
	});
	it("stops after the first failed criterion and records finished failed without later commands", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		const definition: ManagedTaskDefinition = {
			...node(root, "exit 7"),
			validations: [
				{ name: "first", command: "exit 7" },
				{ name: "second", command: "true" },
			],
		};
		await enrollClosed(binding, definition);
		let runs = 0;
		const result = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					runs += 1;
					return {
						exactCommand: spec.command,
						cwd: root,
						exitStatus: spec.command === "exit 7" ? 7 : 0,
						pass: spec.command !== "exit 7",
					};
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(result.status).toBe("failed");
		expect(runs).toBe(1);
		const domain = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{
				attempts: Array<{
					fence: string;
					retired: boolean;
					validation: string;
					verificationExecution: { observations: unknown[]; commands: unknown[] };
				}>;
			}>;
		};
		const attempt = domain.graphs[0]!.attempts[0]!;
		expect(attempt.validation).toBe("finished");
		expect(attempt.fence).toBe("failed");
		expect(attempt.retired).toBe(true);
		expect(attempt.verificationExecution.observations).toHaveLength(1);
		expect(attempt.verificationExecution.commands).toHaveLength(2);
	});
	it("keeps distinct input/output artifacts under a shared recursive write reservation", async () => {
		const { root, binding } = await fixture();
		const src = path.join(root, "src");
		const out = path.join(root, "out");
		await fs.mkdir(src);
		await fs.mkdir(out);
		await fs.writeFile(path.join(src, "a.ts"), "const a = 1;\n");
		await fs.writeFile(path.join(out, "built.txt"), "built");
		const definition: ManagedTaskDefinition = {
			id: "a",
			task: "Write result",
			workspace: root,
			predecessors: [],
			criteriaIdentity: managedIdentity("criteria"),
			validations: [{ name: "exists", command: "test -f out/built.txt" }],
			resources: [{ kind: "path", path: root, mode: "write", recursive: true, namespace: false }],
			artifacts: [
				{ path: src, role: "input", presence: "required" },
				{ path: out, role: "output", presence: "required" },
			],
		};
		await enrollClosed(binding, definition);
		expect(
			await verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: defaultFinalizeChecks(root),
			}),
		).toMatchObject({ status: "accepted" });
		const accepted = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8")) as {
			graphs: Array<{ attempts: Array<{ produced: Array<{ path: string }>; inputs: Array<{ path: string }> }> }>;
		};
		const attempt = accepted.graphs[0]!.attempts[0]!;
		expect(attempt.inputs.some(entry => entry.path === path.join(src, "a.ts") || entry.path === src)).toBe(true);
		expect(attempt.produced.every(entry => entry.path === out || entry.path.startsWith(`${out}${path.sep}`))).toBe(
			true,
		);
		expect(attempt.produced.some(entry => entry.path === src || entry.path.startsWith(`${src}${path.sep}`))).toBe(
			false,
		);
		await fs.writeFile(path.join(src, "a.ts"), "const a = 2;\n");
		const drifted = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(drifted.status).not.toBe("accepted");
	});
	it("refuses verify after the current attempt is canceled or revised", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "test -f result.txt"));
		expect(
			await verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: defaultFinalizeChecks(root),
			}),
		).toMatchObject({ status: "accepted" });
		await transactManagedTaskDomain(
			{ binding, expectedRevision: await currentManagedRevision(binding) },
			async state => {
				cancelManagedTasks(state.graphs[0]!, ["a"]);
			},
		);
		await expect(
			verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: defaultFinalizeChecks(root),
			}),
		).rejects.toThrow(/attempt is fenced|attempt missing/);
	});
	it("replays an unaffected current accepted attempt", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		await enrollClosed(binding, node(root, "test -f result.txt"));
		const first = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(first).toMatchObject({ status: "accepted", started: true });
		const again = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: defaultFinalizeChecks(root),
		});
		expect(again).toMatchObject({ status: "accepted", started: false });
	});
	it("refuses verify of a superseded receipt after task/workspace/criteria revision", async () => {
		const { root, binding } = await fixture();
		await fs.writeFile(path.join(root, "result.txt"), "produced");
		const original = node(root, "test -f result.txt");
		await enrollClosed(binding, original);
		expect(
			await verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: defaultFinalizeChecks(root),
			}),
		).toMatchObject({ status: "accepted" });
		const revisedWorkspace = path.join(root, "revised");
		await fs.mkdir(revisedWorkspace);
		await fs.writeFile(path.join(revisedWorkspace, "result.txt"), "produced");
		await transactManagedTaskDomain(
			{ binding, expectedRevision: await currentManagedRevision(binding) },
			async state => {
				await reviseManagedTaskGraph(state, state.graphs[0]!, [
					{
						...node(revisedWorkspace, "test -f result.txt"),
						task: "Write revised result",
						workspace: revisedWorkspace,
						criteriaIdentity: managedIdentity("criteria-revised"),
						validations: [{ name: "exists", command: "test -f result.txt" }],
					},
				]);
			},
		);
		await expect(
			verifyManagedTaskAttempt({
				binding,
				graphId: "g",
				nodeId: "a",
				owner: "owner",
				runner: defaultFinalizeChecks(root),
			}),
		).rejects.toThrow(/attempt is fenced|attempt missing|attempt definition is not current/);
	});
});
