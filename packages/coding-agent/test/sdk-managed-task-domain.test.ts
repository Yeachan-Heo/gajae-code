import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StatePublicationUncertainError, StateWriteConflictError } from "../src/gjc-runtime/state-writer";
import {
	admitManagedTask,
	createManagedDomainBinding,
	defineManagedTaskGraph,
	type ManagedDomainBinding,
	type ManagedTaskDefinition,
	managedEnrollmentIndexPath,
	managedIdentity,
	managedTaskDomainPath,
	recordManagedEnrollment,
	restoreManagedAttemptRefs,
	transactManagedTaskDomain,
} from "../src/sdk/broker/managed-task-dag";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-domain-"));
	roots.push(root);
	await fs.mkdir(path.join(root, ".gjc"), { mode: 0o755 });
	const binding = await createManagedDomainBinding({
		controlRoot: root,
		agentDir: root,
		enrollmentId: "enrollment",
		worktrees: [root],
	});
	const node = (id: string, resource = "shared"): ManagedTaskDefinition => ({
		id,
		task: `Task ${id}`,
		workspace: root,
		predecessors: [],
		criteriaIdentity: managedIdentity("criteria"),
		validations: [{ name: "check", command: "true" }],
		resources: [{ kind: "integration", identity: resource, mode: "write" }],
		artifacts: [],
	});
	return { root, binding, node };
}
async function enroll(binding: ManagedDomainBinding, nodes: ManagedTaskDefinition[]) {
	return transactManagedTaskDomain(
		{ binding, expectedRevision: 0, assertNoManagedEvidence: async () => {} },
		async state => {
			for (const node of nodes) await defineManagedTaskGraph(state, { id: node.id, owner: node.id, nodes: [node] });
		},
	);
}
function admission(id: string) {
	return {
		graphId: id,
		owner: id,
		nodeId: id,
		attemptId: `attempt-${id}`,
		native: { key: id, identity: managedIdentity(id), requestHash: managedIdentity({ task: id }) },
	};
}

describe("strict private shared domain transactions", () => {
	it("publishes at exact domain address with private modes without chmodding existing parent", async () => {
		const { root, binding, node } = await fixture();
		const result = await enroll(binding, [node("a")]);
		expect(result.state.state_revision).toBe(1);
		expect(managedTaskDomainPath(root)).toBe(path.join(root, ".gjc", "managed-task-domain", "state.json"));
		expect((await fs.stat(path.dirname(managedTaskDomainPath(root)))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(managedTaskDomainPath(root))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.join(root, ".gjc"))).mode & 0o777).toBe(0o755);
	});
	it("fails closed on missing, corrupt, non-object, extra-key, and swapped binding state without callback", async () => {
		const { root, binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		const target = managedTaskDomainPath(root);
		const original = await fs.readFile(target, "utf8");
		let mutations = 0;
		for (const content of [
			"{",
			"[]",
			JSON.stringify({ ...JSON.parse(original), extra: true }),
			JSON.stringify({ ...JSON.parse(original), binding: { ...binding, enrollmentId: "other" } }),
		]) {
			await fs.writeFile(target, content);
			await expect(
				transactManagedTaskDomain({ binding, expectedRevision: 1 }, async () => {
					mutations++;
				}),
			).rejects.toThrow();
			expect(await fs.readFile(target, "utf8")).toBe(content);
		}
		await fs.rm(target);
		await expect(
			transactManagedTaskDomain({ binding, expectedRevision: 1 }, async () => {
				mutations++;
			}),
		).rejects.toThrow("missing");
		expect(mutations).toBe(0);
	});
	it("refuses unsafe existing subtree and explicit enrollment denied by native-evidence callback", async () => {
		const { root, binding } = await fixture();
		await fs.mkdir(path.dirname(managedTaskDomainPath(root)), { mode: 0o755 });
		await expect(
			transactManagedTaskDomain(
				{ binding, expectedRevision: 0, assertNoManagedEvidence: async () => {} },
				async () => {},
			),
		).rejects.toThrow("0700");
		expect((await fs.stat(path.dirname(managedTaskDomainPath(root)))).mode & 0o777).toBe(0o755);
		await fs.chmod(path.dirname(managedTaskDomainPath(root)), 0o700);
		await expect(
			transactManagedTaskDomain(
				{
					binding,
					expectedRevision: 0,
					assertNoManagedEvidence: async () => {
						throw new Error("native evidence exists");
					},
				},
				async () => {},
			),
		).rejects.toThrow("native evidence");
		await expect(fs.stat(managedTaskDomainPath(root))).rejects.toThrow();
	});
	it("rejects immutable native/content rewrite and fabricated acceptance without publishing", async () => {
		const { root, binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
			admitManagedTask(state, admission("a")),
		);
		const before = await fs.readFile(managedTaskDomainPath(root), "utf8");
		await expect(
			transactManagedTaskDomain({ binding, expectedRevision: 2 }, async state => {
				state.graphs[0]!.attempts[0]!.native.requestHash = managedIdentity("changed");
			}),
		).rejects.toThrow("immutable");
		await expect(
			transactManagedTaskDomain({ binding, expectedRevision: 2 }, async state => {
				state.graphs[0]!.attempts[0]!.accepted = { id: "forged", hash: managedIdentity("forged") };
			}),
		).rejects.toThrow(/acceptance requires current finished closed attempt|untrusted acceptance authority/);
		expect(await fs.readFile(managedTaskDomainPath(root), "utf8")).toBe(before);
	});
	it("post-rename failure is uncertain and leaves the complete reservation, never a fresh retry", async () => {
		const { root, binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		const rename = fs.rename;
		const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (String(to) === managedTaskDomainPath(root)) throw new Error("simulated publication acknowledgement loss");
		});
		try {
			await expect(
				transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
					admitManagedTask(state, admission("a")),
				),
			).rejects.toBeInstanceOf(StatePublicationUncertainError);
		} finally {
			fault.mockRestore();
		}
		const persisted = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8"));
		expect(persisted.state_revision).toBe(2);
		expect(persisted.graphs[0].attempts).toHaveLength(1);
		expect(persisted.graphs[0].attempts[0].resources).toHaveLength(1);
		await expect(
			transactManagedTaskDomain({ binding, expectedRevision: 1 }, state => admitManagedTask(state, admission("a"))),
		).rejects.toBeInstanceOf(StateWriteConflictError);
	});
	for (const shared of [true, false])
		it(`separate-process CAS contention: ${shared ? "one competing writer" : "two disjoint writers after retry"}`, async () => {
			const { root, binding, node } = await fixture();
			await enroll(binding, [node("a", shared ? "shared" : "a"), node("b", shared ? "shared" : "b")]);
			const modulePath = path.resolve(import.meta.dir, "../src/sdk/broker/managed-task-dag.ts");
			const script = `
			import * as fs from 'node:fs/promises';
			import { transactManagedTaskDomain, admitManagedTask, managedTaskDomainPath } from ${JSON.stringify(modulePath)};
			const binding = JSON.parse(process.env.DOMAIN_BINDING);
			const request = JSON.parse(process.env.ADMISSION);
			await fs.writeFile(process.env.READY, 'ready');
			let released = false;
			for (let n = 0; n < 1000; n++) { try { await fs.access(process.env.RELEASE); released = true; break; } catch { await Bun.sleep(10); } }
			if (!released) throw new Error('barrier timeout');
			try {
				await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state => admitManagedTask(state, request));
				console.log('admitted');
			} catch (error) {
				if (error.name !== 'StateWriteConflictError') throw error;
				if (process.env.RETRY === 'yes') {
					const state = JSON.parse(await fs.readFile(managedTaskDomainPath(binding.controlRoot), 'utf8'));
					await transactManagedTaskDomain({ binding, expectedRevision: state.state_revision }, state => admitManagedTask(state, request));
					console.log('admitted');
				} else console.log('stale');
			}
		`;
			const release = path.join(root, "release");
			const children = ["a", "b"].map(id =>
				Bun.spawn([process.execPath, "--eval", script], {
					env: {
						...process.env,
						DOMAIN_BINDING: JSON.stringify(binding),
						ADMISSION: JSON.stringify(admission(id)),
						READY: path.join(root, `ready-${id}`),
						RELEASE: release,
						RETRY: shared ? "no" : "yes",
					},
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			try {
				let ready = false;
				for (let n = 0; n < 1000; n++) {
					try {
						await Promise.all(["a", "b"].map(id => fs.access(path.join(root, `ready-${id}`))));
						ready = true;
						break;
					} catch {
						await Bun.sleep(10);
					}
				}
				expect(ready).toBe(true);
				await fs.writeFile(release, "go");
				const output = await Promise.all(
					children.map(async child => ({
						status: await child.exited,
						stdout: await new Response(child.stdout).text(),
						stderr: await new Response(child.stderr).text(),
					})),
				);
				for (const child of output) {
					expect(child.stderr).toBe("");
					expect(child.status).toBe(0);
				}
				expect(output.filter(child => child.stdout.trim() === "admitted")).toHaveLength(shared ? 1 : 2);
				const final = JSON.parse(await fs.readFile(managedTaskDomainPath(root), "utf8"));
				expect(final.state_revision).toBe(shared ? 2 : 3);
				expect(final.graphs.flatMap((g: { attempts: unknown[] }) => g.attempts)).toHaveLength(shared ? 1 : 2);
			} finally {
				for (const child of children) child.kill();
				await Promise.all(children.map(child => child.exited));
			}
		}, 30000);
	it("retires a quiescent canceled attempt and admits a replacement reservation", async () => {
		const { binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
			admitManagedTask(state, admission("a")),
		);
		const canceled = await transactManagedTaskDomain({ binding, expectedRevision: 2 }, async state => {
			const attempt = state.graphs[0]!.attempts[0]!;
			attempt.worker = "closed";
			attempt.fence = "canceled";
		});
		expect(canceled.state.graphs[0]!.attempts[0]!.retired).toBe(true);
		const retried = await transactManagedTaskDomain({ binding, expectedRevision: 3 }, state =>
			admitManagedTask(state, {
				...admission("a"),
				attemptId: "attempt-a-retry",
				native: {
					key: "a-retry",
					identity: managedIdentity("a-retry"),
					requestHash: managedIdentity({ task: "a" }),
				},
			}),
		);
		expect(retried.state.graphs[0]!.attempts.filter(attempt => !attempt.retired)).toHaveLength(1);
		expect(retried.state.graphs[0]!.attempts).toHaveLength(2);
	});
	it("internal observation CAS recomputes under the lock without a stale expectedRevision", async () => {
		const { binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
			admitManagedTask(state, admission("a")),
		);
		const observed = await transactManagedTaskDomain({ binding, internal: true }, async state => {
			state.graphs[0]!.attempts[0]!.worker = "authorized";
		});
		expect(observed.state.state_revision).toBe(3);
		expect(observed.state.graphs[0]!.attempts[0]!.worker).toBe("authorized");
	});
	it("strict user expectedRevision refuses a stale revise mutation", async () => {
		const { binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
			admitManagedTask(state, admission("a")),
		);
		await expect(
			transactManagedTaskDomain({ binding, expectedRevision: 1 }, async () => undefined),
		).rejects.toBeInstanceOf(StateWriteConflictError);
	});
	it("durable enrollment records native keys and fails closed per missing established root", async () => {
		const { root, binding, node } = await fixture();
		await enroll(binding, [node("a")]);
		await transactManagedTaskDomain({ binding, expectedRevision: 1 }, state =>
			admitManagedTask(state, admission("a")),
		);
		const native = managedIdentity("a");
		await recordManagedEnrollment(root, root, native);
		expect(managedEnrollmentIndexPath(root)).toBe(path.join(root, ".gjc", "managed-task-enrollments", "index.json"));
		await fs.rm(managedTaskDomainPath(root));
		const restored = await restoreManagedAttemptRefs(root);
		expect(restored.failedRoots).toContain(root);
		expect(restored.refs).toHaveLength(0);
	});
});
