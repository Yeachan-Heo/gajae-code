import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "../src/capability/types";
import {
	applyExecutionPreset,
	clearExecutionPreset,
	type ExecutionPresetInput,
	ExecutionPresetStore,
	loadPersistentExecutionPresetConfiguration,
	previewExecutionPreset,
} from "../src/config/execution-preset";
import { ModelRegistry } from "../src/config/model-registry";
import { ScopedConfigurationMutationService } from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	DEFAULT_TASK_EXECUTION_POLICY,
	FAILED_PERSISTENT_TASK_EXECUTION_POLICY,
	TASK_CONTROL_PLANE_TOOL_IDS,
	type TaskExecutionPolicy,
	TaskExecutionPolicyController,
} from "../src/task/execution-policy";

const roots: string[] = [];

const USER_POLICY: TaskExecutionPolicy = {
	isolation: "current",
	toolAccess: { allow: ["read"], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 60_000,
	simpleMode: false,
};

const PROJECT_POLICY: TaskExecutionPolicy = {
	isolation: "worktree",
	toolAccess: { allow: ["read", "search"], deny: [] },
	mcpDiscovery: "disabled",
	maxDurationMs: 120_000,
	simpleMode: true,
};

const PERSISTED_PERMISSIVE_POLICY: TaskExecutionPolicy = {
	isolation: "current",
	toolAccess: { allow: ["read", "search", "bash", "write"], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 120_000,
	simpleMode: false,
};

const EXPLICIT_RESTRICTIVE_POLICY: TaskExecutionPolicy = {
	isolation: "worktree",
	toolAccess: { allow: ["read"], deny: ["search", "bash", "write"] },
	mcpDiscovery: "disabled",
	maxDurationMs: 1_000,
	simpleMode: true,
};

function customPreset(id: string, policy: TaskExecutionPolicy): ExecutionPresetInput {
	return {
		id,
		label: id,
		description: `${id} persisted execution preset`,
		policy,
	};
}

async function makeRoot(options: { readonly git?: boolean } = {}): Promise<string> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-execution-preset-restart-"));
	if (options.git ?? true) await fs.mkdir(path.join(root, ".git"), { recursive: true });
	roots.push(root);
	return root;
}

function loadContext(root: string, repoRoot: string | null = root): LoadContext {
	return {
		cwd: root,
		home: path.join(root, "home"),
		repoRoot,
	};
}

function serviceFor(root: string, repoRoot: string | null = root): ScopedConfigurationMutationService {
	return new ScopedConfigurationMutationService({
		loadContext: loadContext(root, repoRoot),
		agentDir: path.join(root, "agent"),
		reloadAndVerify: () => true,
	});
}

async function persistCustomAndActive(
	service: ScopedConfigurationMutationService,
	scope: "project" | "user",
	input: ExecutionPresetInput,
): Promise<{
	readonly store: ExecutionPresetStore;
	readonly controller: TaskExecutionPolicyController;
	readonly preview: ReturnType<typeof previewExecutionPreset>;
}> {
	const store = new ExecutionPresetStore({ scope, scopedMutationService: service });
	const created = await store.createCustom(input);
	expect(created.ok).toBe(true);
	const controller = new TaskExecutionPolicyController();
	const preview = previewExecutionPreset(store, input.id, controller, scope);
	const applied = await applyExecutionPreset(store, preview, controller, scope);
	expect(applied.ok).toBe(true);
	return { store, controller, preview };
}

async function createSession(
	root: string,
	options: {
		readonly executionPolicySnapshot?: ReturnType<TaskExecutionPolicyController["getSnapshot"]>;
		readonly taskExecutionPolicy?: TaskExecutionPolicy;
		readonly taskDepth?: number;
		readonly currentAgentType?: string;
	} = {},
): Promise<{ readonly result: Awaited<ReturnType<typeof createAgentSession>>; readonly authStorage: AuthStorage }> {
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	try {
		const result = await createAgentSession({
			cwd: root,
			agentDir: path.join(root, "agent"),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(root),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...options,
		});
		return { result, authStorage };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

function executionPolicyGetter(result: CreateAgentSessionResult) {
	const getExecutionPolicy = result.getExecutionPolicy;
	if (getExecutionPolicy === undefined) {
		throw new Error("createAgentSession did not expose execution policy controls");
	}
	return getExecutionPolicy;
}

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("execution preset persistence restart", () => {
	it("loads detached user/project definitions with project precedence and safe failures", async () => {
		const root = await makeRoot();
		const service = serviceFor(root);
		const user = await persistCustomAndActive(service, "user", customPreset("user-review", USER_POLICY));

		const first = await loadPersistentExecutionPresetConfiguration(service);
		expect(first.status).toBe("ready");
		expect(first.reason).toBeNull();
		expect(first.sourceScope).toBe("user");
		expect(first.activePreset?.id).toBe("user-review");
		expect(first.activePolicy).toEqual(USER_POLICY);
		expect(first.user.customDefinitions.map(preset => preset.id)).toEqual(["user-review"]);
		expect(first.project.customDefinitions).toHaveLength(0);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.user)).toBe(true);
		expect(Object.isFrozen(first.user.customDefinitions)).toBe(true);
		expect(Object.isFrozen(first.user.customDefinitions[0])).toBe(true);
		expect(Object.isFrozen(first.activePolicy)).toBe(true);
		expect(JSON.stringify(first)).not.toContain("config.yml");

		const project = await persistCustomAndActive(service, "project", customPreset("project-review", PROJECT_POLICY));
		const projectActive = await loadPersistentExecutionPresetConfiguration(service);
		expect(projectActive.status).toBe("ready");
		expect(projectActive.sourceScope).toBe("project");
		expect(projectActive.activePreset?.id).toBe("project-review");
		expect(projectActive.activePolicy).toEqual(PROJECT_POLICY);

		const cleared = await clearExecutionPreset(project.store, project.controller, "project", {
			expectedRevision: project.preview.after.revision,
			expectedFingerprint: project.preview.after.fingerprint,
		});
		expect(cleared.ok).toBe(true);
		const afterProjectClear = await loadPersistentExecutionPresetConfiguration(service);
		expect(afterProjectClear.sourceScope).toBe("user");
		expect(afterProjectClear.activePreset?.id).toBe("user-review");
		expect(afterProjectClear.activePolicy).toEqual(USER_POLICY);

		await service.mutate({
			scope: "project",
			patches: [{ op: "set", path: "execution.presets.active", value: "missing-preset" }],
		});
		const invalidReference = await loadPersistentExecutionPresetConfiguration(service);
		expect(invalidReference.status).toBe("invalid");
		expect(invalidReference.reason).toBe("active_not_found");
		expect(invalidReference.activePreset).toBeNull();
		expect(invalidReference.activePolicy).toBeNull();
		expect(invalidReference.sourceScope).toBeNull();

		await service.mutate({
			scope: "project",
			patches: [
				{ op: "clear", path: "execution.presets.active" },
				{
					op: "set",
					path: "execution.presets.definitions.invalid-policy",
					value: {
						id: "invalid-policy",
						label: "Invalid Policy",
						description: "This must never activate.",
						policy: { isolation: "current" },
					},
				},
			],
		});
		const invalidDefinition = await loadPersistentExecutionPresetConfiguration(service);
		expect(invalidDefinition.status).toBe("invalid");
		expect(invalidDefinition.reason).toBe("invalid_definitions");
		expect(invalidDefinition.activePreset).toBeNull();
		expect(JSON.stringify(invalidDefinition)).not.toContain("invalid-policy");

		void user;
	});

	it("keeps ordinary non-project sessions default and honors persistent/explicit precedence", async () => {
		const root = await makeRoot({ git: false });
		const service = serviceFor(root, null);
		const absent = await loadPersistentExecutionPresetConfiguration(service);
		expect(absent.status).toBe("absent");
		expect(absent.reason).toBeNull();
		expect(absent.sourceScope).toBeNull();
		expect(absent.activePreset).toBeNull();
		expect(absent.activePolicy).toBeNull();

		const defaultSession = await createSession(root);
		const getDefaultExecutionPolicy = executionPolicyGetter(defaultSession.result);
		try {
			expect(getDefaultExecutionPolicy().policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
			expect(getDefaultExecutionPolicy().source.kind).toBe("default");
		} finally {
			await defaultSession.result.session.dispose();
			defaultSession.authStorage.close();
		}

		await persistCustomAndActive(
			service,
			"user",
			customPreset("non-project-persistent", PERSISTED_PERMISSIVE_POLICY),
		);
		const persistentSession = await createSession(root);
		const getPersistentExecutionPolicy = executionPolicyGetter(persistentSession.result);
		try {
			expect(getPersistentExecutionPolicy().policy).toEqual(PERSISTED_PERMISSIVE_POLICY);
			expect(getPersistentExecutionPolicy().source.kind).toBe("session");
		} finally {
			await persistentSession.result.session.dispose();
			persistentSession.authStorage.close();
		}

		const explicitSession = await createSession(root, { taskExecutionPolicy: EXPLICIT_RESTRICTIVE_POLICY });
		const getExplicitExecutionPolicy = executionPolicyGetter(explicitSession.result);
		try {
			expect(getExplicitExecutionPolicy().policy).toEqual(EXPLICIT_RESTRICTIVE_POLICY);
			expect(getExplicitExecutionPolicy().source.kind).toBe("session");
		} finally {
			await explicitSession.result.session.dispose();
			explicitSession.authStorage.close();
		}
	});

	it("locks startup to the failed-persistence policy for invalid active and definition state", async () => {
		const root = await makeRoot();
		const service = serviceFor(root);
		await persistCustomAndActive(service, "user", customPreset("restart-permissive", PERSISTED_PERMISSIVE_POLICY));
		const expected = new TaskExecutionPolicyController(FAILED_PERSISTENT_TASK_EXECUTION_POLICY).getSnapshot();

		const assertFailedClosedSession = async (): Promise<void> => {
			const created = await createSession(root);
			const snapshot = executionPolicyGetter(created.result)();
			try {
				expect(snapshot.policy).toEqual(FAILED_PERSISTENT_TASK_EXECUTION_POLICY);
				expect(snapshot.fingerprint).toBe(expected.fingerprint);
				expect(snapshot.source.kind).toBe("session");
				expect(snapshot.policy.isolation).toBe("worktree");
				expect(snapshot.policy.toolAccess.allow).toEqual([...TASK_CONTROL_PLANE_TOOL_IDS]);
				expect(snapshot.policy.toolAccess.deny).toEqual(["bash", "edit", "write"]);
				expect(snapshot.policy.mcpDiscovery).toBe("disabled");
				expect(snapshot.policy.maxDurationMs).toBe(1_000);
				expect(snapshot.policy.simpleMode).toBe(true);
			} finally {
				await created.result.session.dispose();
				created.authStorage.close();
			}
		};

		await service.mutate({
			scope: "project",
			patches: [{ op: "set", path: "execution.presets.active", value: "missing-preset" }],
		});
		await assertFailedClosedSession();

		await service.mutate({
			scope: "project",
			patches: [
				{ op: "clear", path: "execution.presets.active" },
				{
					op: "set",
					path: "execution.presets.definitions.invalid-policy",
					value: {
						id: "invalid-policy",
						label: "Invalid Policy",
						description: "This must never activate.",
						policy: { isolation: "current" },
					},
				},
			],
		});
		await assertFailedClosedSession();
	});

	it("applies a durable active preset after restart before launch and isolates child snapshots", async () => {
		const root = await makeRoot();
		const service = serviceFor(root);
		await persistCustomAndActive(service, "user", customPreset("restart-build", USER_POLICY));

		const first = await createSession(root);
		const getFirstExecutionPolicy = executionPolicyGetter(first.result);
		try {
			expect(getFirstExecutionPolicy().policy).toEqual(USER_POLICY);
			expect(getFirstExecutionPolicy().source.kind).toBe("session");
		} finally {
			await first.result.session.dispose();
			first.authStorage.close();
		}

		const second = await createSession(root);
		const getSecondExecutionPolicy = executionPolicyGetter(second.result);
		try {
			expect(getSecondExecutionPolicy().policy).toEqual(USER_POLICY);
			const childSnapshot = new TaskExecutionPolicyController().getSnapshot();
			const child = await createSession(root, {
				executionPolicySnapshot: childSnapshot,
				taskDepth: 1,
				currentAgentType: "sub",
			});
			const getChildExecutionPolicy = executionPolicyGetter(child.result);
			try {
				expect(getChildExecutionPolicy()).toEqual(childSnapshot);
				expect(getChildExecutionPolicy().policy).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
			} finally {
				await child.result.session.dispose();
				child.authStorage.close();
			}
		} finally {
			await second.result.session.dispose();
			second.authStorage.close();
		}
	});
	it("keeps an explicit restrictive policy authoritative across restart and child snapshots", async () => {
		const root = await makeRoot();
		const service = serviceFor(root);
		await persistCustomAndActive(service, "user", customPreset("restart-permissive", PERSISTED_PERMISSIVE_POLICY));

		const expectedExplicitSnapshot = new TaskExecutionPolicyController(EXPLICIT_RESTRICTIVE_POLICY).getSnapshot();
		const parent = await createSession(root, { taskExecutionPolicy: EXPLICIT_RESTRICTIVE_POLICY });
		const getParentExecutionPolicy = executionPolicyGetter(parent.result);
		try {
			const parentSnapshot = getParentExecutionPolicy();
			expect(parentSnapshot.policy).toEqual(EXPLICIT_RESTRICTIVE_POLICY);
			expect(parentSnapshot.source.kind).toBe("session");
			expect(parentSnapshot.fingerprint).toBe(expectedExplicitSnapshot.fingerprint);
			expect(parentSnapshot.policy).not.toEqual(PERSISTED_PERMISSIVE_POLICY);

			const child = await createSession(root, {
				executionPolicySnapshot: parentSnapshot,
				taskDepth: 1,
				currentAgentType: "sub",
			});
			const getChildExecutionPolicy = executionPolicyGetter(child.result);
			try {
				expect(getChildExecutionPolicy()).toEqual(parentSnapshot);
				expect(getChildExecutionPolicy().fingerprint).toBe(parentSnapshot.fingerprint);
			} finally {
				await child.result.session.dispose();
				child.authStorage.close();
			}
		} finally {
			await parent.result.session.dispose();
			parent.authStorage.close();
		}

		const recreated = await createSession(root);
		const getRecreatedExecutionPolicy = executionPolicyGetter(recreated.result);
		try {
			const recreatedSnapshot = getRecreatedExecutionPolicy();
			expect(recreatedSnapshot.policy).toEqual(PERSISTED_PERMISSIVE_POLICY);
			expect(recreatedSnapshot.source.kind).toBe("session");
		} finally {
			await recreated.result.session.dispose();
			recreated.authStorage.close();
		}
	});
});
