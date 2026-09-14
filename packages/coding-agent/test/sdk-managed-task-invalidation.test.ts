import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	admitManagedTask,
	assertManagedManifestCurrent,
	cancelManagedTasks,
	canRetireManagedAttempt,
	createManagedDomainBinding,
	currentManagedRevision,
	defineManagedTaskGraph,
	type ManagedDomainBinding,
	type ManagedTaskDefinition,
	managedIdentity,
	readyManagedTasks,
	reducedWorkroomManagedDefinitions,
	reviseManagedTaskGraph,
	transactManagedTaskDomain,
} from "../src/sdk/broker/managed-task-dag";
import { verifyManagedTaskAttempt } from "../src/sdk/broker/managed-task-verification";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-invalidate-"));
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

function native(key: string) {
	return { key, identity: managedIdentity(key), requestHash: managedIdentity({ task: key }) };
}

async function writerNode(
	root: string,
	id: string,
	predecessors: string[],
	extra: Partial<ManagedTaskDefinition> = {},
): Promise<ManagedTaskDefinition> {
	const workspace = path.join(root, id);
	await fs.mkdir(workspace, { recursive: true });
	const output = path.join(workspace, "result.txt");
	return {
		id,
		task: extra.task ?? `Task ${id}`,
		workspace,
		predecessors,
		criteriaIdentity: extra.criteriaIdentity ?? managedIdentity("criteria"),
		validations: extra.validations ?? [{ name: "ok", command: "true" }],
		resources: extra.resources ?? [
			{ kind: "path", path: output, mode: "write", recursive: false, namespace: false },
			{ kind: "path", path: workspace, mode: "write", recursive: false, namespace: true },
		],
		artifacts: extra.artifacts ?? [{ path: output, role: "output", presence: "required" }],
	};
}

async function enroll(binding: ManagedDomainBinding, nodes: ManagedTaskDefinition[]) {
	await transactManagedTaskDomain(
		{ binding, expectedRevision: 0, assertNoManagedEvidence: async () => {} },
		async state => {
			await defineManagedTaskGraph(state, { id: "g", owner: "owner", nodes });
		},
	);
}

describe("managed invalidation (M5)", () => {
	it("preserves the reduced Workroom graph and does not treat S11 as a common prerequisite", async () => {
		const { root, binding } = await fixture();
		await enroll(binding, reducedWorkroomManagedDefinitions(root, managedIdentity("criteria")));
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, async state => {
			const graph = state.graphs[0]!;
			expect(readyManagedTasks(graph)).toEqual(["S11", "S5"]);
			expect(graph.nodes.find(node => node.definition.id === "S8")!.definition.predecessors.toSorted()).toEqual([
				"S7",
				"UI1a",
			]);
			expect(graph.nodes.find(node => node.definition.id === "UI2")!.definition.predecessors).toEqual(["UI1b"]);
			expect(graph.nodes.find(node => node.definition.id === "S10b")!.definition.predecessors).toEqual(["S10a"]);
			expect(graph.nodes.find(node => node.definition.id === "S9b")!.definition.predecessors).toEqual(["S9a"]);
			expect(
				graph.nodes.every(node => node.definition.id === "S11" || !node.definition.predecessors.includes("S11")),
			).toBe(true);
		});
	});

	it("revises union old/new downstream closure and keeps unrelated accepted PASS current", async () => {
		const { root, binding } = await fixture();
		const nodeA = await writerNode(root, "a", []);
		const nodeB = await writerNode(root, "b", ["a"]);
		const nodeC = await writerNode(root, "c", []);
		await fs.writeFile(path.join(root, "a", "result.txt"), "a");
		await fs.writeFile(path.join(root, "c", "result.txt"), "c");
		await enroll(binding, [nodeA, nodeB, nodeC]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, async state => {
			await admitManagedTask(state, {
				graphId: "g",
				owner: "owner",
				nodeId: "a",
				attemptId: "attempt-a",
				native: native("a"),
			});
			await admitManagedTask(state, {
				graphId: "g",
				owner: "owner",
				nodeId: "c",
				attemptId: "attempt-c",
				native: native("c"),
			});
			for (const attempt of state.graphs[0]!.attempts) attempt.worker = "closed";
		});
		expect((await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner" })).status).toBe(
			"accepted",
		);
		expect((await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "c", owner: "owner" })).status).toBe(
			"accepted",
		);
		await transactManagedTaskDomain(
			{ binding, expectedRevision: await currentManagedRevision(binding) },
			async state => {
				const graph = state.graphs[0]!;
				const affected = await reviseManagedTaskGraph(state, graph, [
					{ ...nodeA, task: "changed A" },
					nodeB,
					nodeC,
				]);
				expect(affected).toEqual(["a", "b"]);
				expect(graph.attempts.find(attempt => attempt.nodeId === "a")!.fence).toBe("superseded");
				expect(graph.attempts.find(attempt => attempt.nodeId === "c")!.fence).toBe("current");
				expect(graph.attempts.find(attempt => attempt.nodeId === "c")!.accepted).not.toBeNull();
				expect(readyManagedTasks(graph)).not.toContain("b");
			},
		);
	});

	it("rejects successor admission after consumed P drift and allows cache-only Q change", async () => {
		const { root, binding } = await fixture();
		const workspace = path.join(root, "a");
		await fs.mkdir(workspace, { recursive: true });
		const output = path.join(workspace, "result.txt");
		const report = path.join(workspace, "report.json");
		await fs.writeFile(output, "produced");
		await enroll(binding, [
			await writerNode(root, "a", [], {
				resources: [
					{ kind: "path", path: output, mode: "write", recursive: false, namespace: false },
					{ kind: "path", path: report, mode: "write", recursive: false, namespace: false },
					{ kind: "path", path: workspace, mode: "write", recursive: false, namespace: true },
				],
				artifacts: [
					{ path: output, role: "output", presence: "required" },
					{ path: report, role: "validation-output", presence: "optional" },
				],
			}),
		]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, async state => {
			await admitManagedTask(state, {
				graphId: "g",
				owner: "owner",
				nodeId: "a",
				attemptId: "attempt-a",
				native: native("a"),
			});
			state.graphs[0]!.attempts[0]!.worker = "closed";
		});
		expect((await verifyManagedTaskAttempt({ binding, graphId: "g", nodeId: "a", owner: "owner" })).status).toBe(
			"accepted",
		);
		const domain = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "managed-task-domain", "state.json"), "utf8"),
		);
		const produced = domain.graphs[0].attempts[0].produced;
		await fs.writeFile(report, "cache");
		await assertManagedManifestCurrent(binding, produced);
		await fs.writeFile(output, "drift");
		await expect(assertManagedManifestCurrent(binding, produced)).rejects.toThrow("drift");
	});

	it("fences in-flight verify so a late runner cannot mint stale PASS", async () => {
		const { root, binding } = await fixture();
		const definition = await writerNode(root, "a", []);
		await fs.writeFile(path.join(root, "a", "result.txt"), "produced");
		await enroll(binding, [definition]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, async state => {
			await admitManagedTask(state, {
				graphId: "g",
				owner: "owner",
				nodeId: "a",
				attemptId: "attempt-a",
				native: native("a"),
			});
			state.graphs[0]!.attempts[0]!.worker = "closed";
		});
		const result = await verifyManagedTaskAttempt({
			binding,
			graphId: "g",
			nodeId: "a",
			owner: "owner",
			runner: {
				runValidation: async spec => {
					await transactManagedTaskDomain(
						{ binding, expectedRevision: await currentManagedRevision(binding) },
						async state => {
							await reviseManagedTaskGraph(state, state.graphs[0]!, [{ ...definition, task: "revised" }]);
						},
					);
					return { exactCommand: spec.command, cwd: definition.workspace, exitStatus: 0, pass: true };
				},
				resolveCommit: async () => null,
				commitOnBranch: async () => false,
				prOrIssue: async () => ({ prUrl: null, issueArtifact: null }),
			},
		});
		expect(result.status).toBe("failed");
		await transactManagedTaskDomain(
			{ binding, expectedRevision: await currentManagedRevision(binding) },
			async state => {
				const attempt = state.graphs[0]!.attempts[0]!;
				expect(attempt.accepted).toBeNull();
				expect(attempt.fence).toBe("superseded");
				expect(attempt.validation).toBe("finished");
				expect(attempt.retired).toBe(true);
				expect(canRetireManagedAttempt(attempt)).toBe(true);
				cancelManagedTasks(state.graphs[0]!, ["a"]);
				expect(attempt.fence).toBe("superseded");
			},
		);
	});
});
