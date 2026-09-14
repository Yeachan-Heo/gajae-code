import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	admitManagedTask,
	assertManagedManifestCurrent,
	cancelManagedTasks,
	canonicalizeManagedResources,
	canRetireManagedAttempt,
	captureManagedManifest,
	createManagedDomainBinding,
	defineManagedTaskGraph,
	type ManagedResource,
	type ManagedTaskDefinition,
	type ManagedTaskDomain,
	managedIdentity,
	managedResourcesConflict,
	parseManagedTaskDefinitions,
	readyManagedTasks,
	reviseManagedTaskGraph,
	validateManagedTaskDomain,
} from "../src/sdk/broker/managed-task-dag";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-dag-"));
	roots.push(root);
	const binding = await createManagedDomainBinding({
		controlRoot: root,
		agentDir: root,
		enrollmentId: "enrollment",
		worktrees: [root],
	});
	const state: ManagedTaskDomain = { version: 1, state_revision: 0, binding, graphs: [] };
	const node = (
		id: string,
		predecessors: string[] = [],
		resources: ManagedResource[] = [],
	): ManagedTaskDefinition => ({
		id,
		predecessors,
		task: `Implement ${id}`,
		workspace: root,
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "check", command: "true" }],
		resources,
		artifacts: [],
	});
	return { root, binding, state, node };
}
function native(key: string) {
	return { key, identity: managedIdentity(key), requestHash: managedIdentity({ task: key }) };
}
function resource(p: string, mode: "read" | "write", recursive = false): ManagedResource {
	return { kind: "path", path: p, mode, recursive, namespace: false };
}

describe("managed DAG policy (no native effects or verification authority)", () => {
	it("rejects duplicate, missing, cyclic, extra-key, and empty-validation graphs", async () => {
		const { node } = await fixture();
		for (const nodes of [
			[node("a"), node("a")],
			[node("a", ["missing"])],
			[node("a", ["b"]), node("b", ["a"])],
			[{ ...node("a"), pass: true }],
			[{ ...node("a"), validations: [] }],
		]) {
			expect(() => parseManagedTaskDefinitions(nodes)).toThrow();
		}
	});
	it("readiness is deterministic, dependency-based, and never inferred from closed worker", async () => {
		const { state, node } = await fixture();
		const graph = await defineManagedTaskGraph(state, {
			id: "graph",
			owner: "owner",
			nodes: [node("b", ["a"]), node("z"), node("a")],
		});
		expect(readyManagedTasks(graph)).toEqual(["a", "z"]);
		await admitManagedTask(state, {
			graphId: graph.id,
			owner: graph.owner,
			nodeId: "a",
			attemptId: "attempt-a",
			native: native("a"),
		});
		graph.attempts[0]!.worker = "closed";
		expect(readyManagedTasks(graph)).toEqual(["z"]);
		expect(canRetireManagedAttempt(graph.attempts[0]!)).toBe(false);
	});
	it("admits independent readers but denies a competing writer all-or-none across owners", async () => {
		const { state, root, node } = await fixture();
		const file = path.join(root, "input");
		await fs.writeFile(file, "input");
		for (const [id, mode] of [
			["a", "read"],
			["b", "read"],
			["c", "write"],
		] as const) {
			await defineManagedTaskGraph(state, { id, owner: id, nodes: [node(id, [], [resource(file, mode)])] });
		}
		for (const id of ["a", "b"])
			await admitManagedTask(state, { graphId: id, owner: id, nodeId: id, attemptId: id, native: native(id) });
		await expect(
			admitManagedTask(state, { graphId: "c", owner: "c", nodeId: "c", attemptId: "c", native: native("c") }),
		).rejects.toThrow("resource conflict");
		expect(state.graphs.map(g => g.attempts.length)).toEqual([1, 1, 0]);
		expect(validateManagedTaskDomain(state).graphs.length).toBe(3);
	});
	it("checks path segments, absent suffixes, hardlinks, symlinks, enrolled aliases, and port wildcards", async () => {
		const { root, binding } = await fixture();
		await fs.mkdir(path.join(root, "a"));
		await fs.mkdir(path.join(root, "ab"));
		await fs.writeFile(path.join(root, "file"), "x");
		await fs.link(path.join(root, "file"), path.join(root, "hardlink"));
		const values = await canonicalizeManagedResources(binding, [
			resource(path.join(root, "a"), "write", true),
			resource(path.join(root, "a", "absent"), "read"),
			resource(path.join(root, "ab"), "write"),
			resource(path.join(root, "file"), "write"),
			resource(path.join(root, "hardlink"), "read"),
		]);
		expect(managedResourcesConflict(values[0]!, values[1]!)).toBe(true);
		expect(managedResourcesConflict(values[0]!, values[2]!)).toBe(false);
		expect(managedResourcesConflict(values[3]!, values[4]!)).toBe(true);
		await fs.symlink(path.join(root, "a"), path.join(root, "alias"));
		await expect(
			canonicalizeManagedResources(binding, [resource(path.join(root, "alias", "new"), "write")]),
		).rejects.toThrow("alias");
		const enrolled = await createManagedDomainBinding({
			controlRoot: root,
			agentDir: root,
			enrollmentId: "enrollment",
			worktrees: [root, path.join(root, "a")],
			aliases: [path.join(root, "alias")],
		});
		const aliases = await canonicalizeManagedResources(enrolled, [
			resource(path.join(root, "alias", "new"), "write"),
			resource(path.join(root, "a", "new"), "read"),
		]);
		expect(managedResourcesConflict(aliases[0]!, aliases[1]!)).toBe(true);
		const ports = await canonicalizeManagedResources(binding, [
			{ kind: "port", protocol: "tcp", address: "*", port: 8123, mode: "write" },
			{ kind: "port", protocol: "tcp", address: "127.0.0.1", port: 8123, mode: "read" },
		]);
		expect(managedResourcesConflict(ports[0]!, ports[1]!)).toBe(true);
		await expect(
			canonicalizeManagedResources(binding, [{ kind: "database", identity: "Database Alias", mode: "write" }]),
		).rejects.toThrow("canonical identity");
	});
	it("rejects overlapping Q/P roles and missing namespace writes before graph mutation", async () => {
		const { root, state, node } = await fixture();
		const output = path.join(root, "result");
		const definition = {
			...node("a", [], [resource(output, "write")]),
			artifacts: [{ path: output, role: "output", presence: "required" }],
		};
		await expect(defineManagedTaskGraph(state, { id: "g", owner: "o", nodes: [definition] })).rejects.toThrow(
			"namespace",
		);
		definition.resources.push({ kind: "path", path: root, mode: "write", recursive: false, namespace: true });
		await expect(
			defineManagedTaskGraph(state, {
				id: "g",
				owner: "o",
				nodes: [
					{
						...definition,
						artifacts: [
							...definition.artifacts,
							{ path: output, role: "validation-output", presence: "optional" },
						],
					},
				],
			}),
		).rejects.toThrow("roles");
		expect(state.graphs).toHaveLength(0);
	});
	it("allows absent output to become produced bytes without changing definition and detects input drift", async () => {
		const { root, binding } = await fixture();
		const output = path.join(root, "result");
		const initial = await captureManagedManifest(binding, [output]);
		expect(initial[0]!.kind).toBe("absent");
		await fs.writeFile(output, "produced");
		const produced = await captureManagedManifest(binding, [output]);
		expect(produced[0]!.kind).toBe("file");
		await assertManagedManifestCurrent(binding, produced);
		await fs.writeFile(path.join(root, "unrelated"), "unrelated");
		await assertManagedManifestCurrent(binding, produced);
		await fs.writeFile(output, "changed");
		await expect(assertManagedManifestCurrent(binding, produced)).rejects.toThrow("drift");
	});
	it("selectively invalidates union-edge downstream closure and holds unknown validator resources", async () => {
		const { state, node } = await fixture();
		const graph = await defineManagedTaskGraph(state, {
			id: "g",
			owner: "o",
			nodes: [node("a"), node("b", ["a"]), node("c")],
		});
		for (const id of ["a", "c"])
			await admitManagedTask(state, { graphId: "g", owner: "o", nodeId: id, attemptId: id, native: native(id) });
		const immutable = structuredClone(graph.attempts[0]!.definition);
		expect(
			await reviseManagedTaskGraph(state, graph, [{ ...node("a"), task: "changed" }, node("b"), node("c")]),
		).toEqual(["a", "b"]);
		expect(graph.attempts[0]!.definition).toEqual(immutable);
		expect(graph.attempts[1]!.fence).toBe("current");
		const attempt = graph.attempts[0]!;
		attempt.worker = "closed";
		attempt.validation = "unknown";
		expect(canRetireManagedAttempt(attempt)).toBe(false);
		attempt.validation = "finished";
		expect(canRetireManagedAttempt(attempt)).toBe(true);
		cancelManagedTasks(graph, ["b"]);
		expect(readyManagedTasks(graph)).not.toContain("b");
	});
});
