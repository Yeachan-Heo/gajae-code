import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { type SettingPath, Settings } from "@gajae-code/coding-agent/config/settings";
import { BUILTIN_TOOL_DESCRIPTORS, LazyAgentTool, type ToolSession } from "@gajae-code/coding-agent/tools";

// A discoverable tool is advertised before its implementation loads. If the advertised description
// changes once the implementation loads, the provider-visible `tools` block changes mid-session and
// the prompt-cache prefix is lost (#5992).

const ENV_KEYS = ["GJC_PY", "PI_PY", "PI_JS"] as const;
let savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));
	for (const key of ENV_KEYS) delete Bun.env[key];
});
afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

function session(
	overrides: Partial<Record<SettingPath, unknown>> = {},
	sessionOverrides: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(overrides),
		...sessionOverrides,
	};
}

async function descriptionBeforeAndAfterLoad(name: string, toolSession: ToolSession, beforeLoad?: () => void) {
	const descriptor = BUILTIN_TOOL_DESCRIPTORS[name];
	if (!descriptor) throw new Error(`no descriptor for ${name}`);
	const facade = new LazyAgentTool(descriptor, undefined, () => descriptor.load(toolSession), toolSession);
	const before = facade.description;
	const parametersBefore = name === "task" ? JSON.stringify(facade.parameters) : undefined;
	beforeLoad?.();
	await facade.materializeForTests();
	return {
		before,
		after: facade.description,
		parametersBefore,
		parametersAfter: name === "task" ? JSON.stringify(facade.parameters) : undefined,
	};
}

const discoverableDescriptors = Object.values(BUILTIN_TOOL_DESCRIPTORS).filter(
	descriptor => descriptor.metadata.loadMode === "discoverable",
);

const explicitUnavailableReasons: Readonly<Record<string, string>> = {
	ask: "the test session has no UI or workflow-gate emitter",
	ssh: "SSH host discovery depends on machine-specific configuration and returns no test host",
	recipe: "the temporary test workspace has no detected recipe runner tasks",
	irc: "IRC is disabled or has no registered caller in this test session",
	telegram_send: "isolated Settings do not configure Telegram delivery",
};
const loadAsUnavailable = new Set(["ssh", "recipe", "telegram_send"]);

function unavailableReason(name: string, toolSession: ToolSession): string {
	return explicitUnavailableReasons[name] ?? `descriptor.isAvailable is false for session cwd ${toolSession.cwd}`;
}

async function assertDiscoverableParityForSession(toolSession: ToolSession, configuration: string): Promise<void> {
	const expectedNames = discoverableDescriptors.map(descriptor => descriptor.metadata.name).sort();
	const availability = new Map(
		discoverableDescriptors.map(descriptor => [descriptor.metadata.name, descriptor.isAvailable(toolSession)]),
	);
	const expectedDescriptorAvailable = [...availability]
		.filter(([, value]) => value)
		.map(([name]) => name)
		.sort();
	const expectedMaterialized = expectedDescriptorAvailable.filter(name => !loadAsUnavailable.has(name));
	const expectedUnavailable = expectedNames.filter(name => !expectedMaterialized.includes(name));
	const expectedUnavailableReasons = new Map(
		expectedUnavailable.map(name => [
			name,
			availability.get(name) === true ? explicitUnavailableReasons[name] : unavailableReason(name, toolSession),
		]),
	);
	const visited = new Set<string>();
	const descriptorAvailable = new Set<string>();
	const materialized = new Set<string>();
	const unavailable = new Map<string, string>();

	for (const descriptor of discoverableDescriptors) {
		const name = descriptor.metadata.name;
		expect(visited.has(name), `${configuration}: duplicate descriptor visit for ${name}`).toBe(false);
		visited.add(name);
		const isAvailable = availability.get(name) === true;
		if (isAvailable) descriptorAvailable.add(name);

		if (!isAvailable) {
			unavailable.set(name, unavailableReason(name, toolSession));
			continue;
		}
		const factoryUnavailableReason = explicitUnavailableReasons[name];
		if (loadAsUnavailable.has(name)) {
			expect(
				factoryUnavailableReason,
				`${configuration}: ${name} needs an explicit unavailable reason`,
			).toBeDefined();
			const implementation = await descriptor.load(toolSession);
			expect(implementation, `${configuration}: ${name} unavailable: ${factoryUnavailableReason}`).toBeNull();
			unavailable.set(name, factoryUnavailableReason ?? "missing test-only unavailable reason");
			continue;
		}

		const observed = await descriptionBeforeAndAfterLoad(name, toolSession);
		expect(observed.before, `${configuration}: ${name} description changed after materialization`).toBe(
			observed.after,
		);
		if (name === "task") {
			expect(observed.parametersBefore, `${configuration}: task pre-load parameters missing`).toBeDefined();
			expect(observed.parametersBefore, `${configuration}: task parameters changed after materialization`).toBe(
				observed.parametersAfter,
			);
		}
		materialized.add(name);
	}

	expect([...visited].sort(), `${configuration}: visited descriptors differ from the discoverable set`).toEqual(
		expectedNames,
	);
	expect([...descriptorAvailable].sort(), `${configuration}: descriptor availability set changed`).toEqual(
		expectedDescriptorAvailable,
	);
	expect([...materialized].sort(), `${configuration}: materialized descriptors differ from expected`).toEqual(
		expectedMaterialized,
	);
	expect([...unavailable.keys()].sort(), `${configuration}: unavailable descriptors need explicit reasons`).toEqual(
		expectedUnavailable,
	);
	expect(
		[...unavailable.entries()].sort(([left], [right]) => left.localeCompare(right)),
		`${configuration}: unavailable descriptors and reasons differ from expected`,
	).toEqual([...expectedUnavailableReasons.entries()].sort(([left], [right]) => left.localeCompare(right)));
	for (const [name, reason] of unavailable) {
		expect(reason.trim().length, `${configuration}: ${name} has an empty unavailable reason`).toBeGreaterThan(0);
	}
}

async function withTempSession(
	label: string,
	overrides: Partial<Record<SettingPath, unknown>>,
	sessionOverrides: Partial<ToolSession>,
	run: (toolSession: ToolSession, cwd: string) => Promise<void>,
): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-description-${label}-`));
	try {
		await run(session(overrides, { cwd, ...sessionOverrides }), cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

describe("discoverable tool descriptions are stable across first load (#5992)", () => {
	it("visits every discoverable descriptor and checks availability and parity per session configuration", async () => {
		expect(discoverableDescriptors.map(descriptor => descriptor.metadata.name)).toEqual(
			expect.arrayContaining(Object.keys(explicitUnavailableReasons)),
		);
		await withTempSession("default", {}, {}, toolSession =>
			assertDiscoverableParityForSession(toolSession, "default session"),
		);
		await withTempSession("isolation", { "task.isolation.mode": "auto" }, {}, toolSession =>
			assertDiscoverableParityForSession(toolSession, "isolation-enabled session"),
		);
		await withTempSession("schema-free", { "task.simple": "schema-free" }, {}, toolSession =>
			assertDiscoverableParityForSession(toolSession, "schema-free session"),
		);
		await withTempSession("independent", { "task.simple": "independent" }, {}, toolSession =>
			assertDiscoverableParityForSession(toolSession, "independent session"),
		);
		await withTempSession("project-agent", {}, {}, async (toolSession, cwd) => {
			const agentsDir = path.join(cwd, ".gjc", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await fs.writeFile(
				path.join(agentsDir, "reviewer-lite.md"),
				"---\nname: reviewer-lite\ndescription: Lightweight project reviewer\n---\nYou review code.\n",
			);
			await assertDiscoverableParityForSession(toolSession, "project-agent session");
		});
		await withTempSession(
			"irc-available",
			{ "irc.enabled": true },
			{ agentRegistry: {} as NonNullable<ToolSession["agentRegistry"]>, getAgentId: () => "0-test" },
			toolSession => assertDiscoverableParityForSession(toolSession, "IRC-available session"),
		);
	});
	it.each([
		["isolation enabled", { "task.isolation.mode": "auto" }, true],
		["schema-free mode", { "task.simple": "schema-free" }, false],
		["independent mode", { "task.simple": "independent" }, false],
	] as const)("keeps task parameters stable for %s", async (_label, overrides, isolationEnabled) => {
		const observed = await descriptionBeforeAndAfterLoad("task", session(overrides));

		expect(observed).toBeDefined();
		expect(observed?.before).toBe(observed?.after);
		expect(observed?.parametersBefore).toBeDefined();
		expect(observed?.parametersBefore).toBe(observed?.parametersAfter);
		if (isolationEnabled) expect(observed?.parametersBefore).toContain('"isolated"');
		else expect(observed?.parametersBefore).not.toContain('"isolated"');
	});
	it("keeps task description stable when a project agent is discovered", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-description-agent-"));
		try {
			const agentsDir = path.join(cwd, ".gjc", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await fs.writeFile(
				path.join(agentsDir, "reviewer-lite.md"),
				"---\nname: reviewer-lite\ndescription: Lightweight project reviewer\n---\nYou review code.\n",
			);
			const observed = await descriptionBeforeAndAfterLoad("task", session({}, { cwd }));

			expect(observed).toBeDefined();
			expect(observed?.before).toBe(observed?.after);
			for (const name of ["executor", "architect", "planner", "critic"]) {
				expect(observed?.before).toContain(name);
			}
			expect(observed?.before).not.toContain("reviewer-lite");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps parity when a project agent overrides a bundled role name", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-description-override-"));
		try {
			const agentsDir = path.join(cwd, ".gjc", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await fs.writeFile(
				path.join(agentsDir, "executor.md"),
				"---\nname: executor\ndescription: Project-specific executor policy\n---\nYou handle project tasks.\n",
			);
			const observed = await descriptionBeforeAndAfterLoad("task", session({}, { cwd }));

			expect(observed).toBeDefined();
			expect(observed?.before).toBe(observed?.after);
			expect(observed?.before).toContain("Bundled role names: executor, architect, planner, critic.");
			expect(observed?.before).toContain(
				"A configured agent may override a bundled role name and takes precedence.",
			);
			expect(observed?.before).not.toContain("Autonomous implementation agent for bounded code changes");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("keeps task description stable when irc becomes available", async () => {
		let ircAvailable = false;
		const toolSession = session(
			{ "irc.enabled": true },
			{
				getToolByName: name => (name === "irc" && ircAvailable ? ({ name: "irc" } as never) : undefined),
			},
		);
		const observed = await descriptionBeforeAndAfterLoad("task", toolSession, () => {
			ircAvailable = true;
		});

		expect(observed).toBeDefined();
		expect(observed?.before).toBe(observed?.after);
	});

	it.each([
		["line-number display", { readLineNumbers: true, readHashLines: false } as Partial<Record<SettingPath, unknown>>],
		["plain display", { readLineNumbers: false, readHashLines: false } as Partial<Record<SettingPath, unknown>>],
	])("#given a %s session #when search loads #then its advertised description does not change", async (_label, overrides) => {
		// given
		const toolSession = session(overrides);

		// when
		const observed = await descriptionBeforeAndAfterLoad("search", toolSession);

		// then
		expect(observed).toBeDefined();
		expect(observed?.before).toBe(observed?.after);
	});

	it.each([
		["python only", { "eval.py": true, "eval.js": false } as Partial<Record<SettingPath, unknown>>, undefined],
		["javascript only", { "eval.py": false, "eval.js": true } as Partial<Record<SettingPath, unknown>>, undefined],
		[
			"GJC_PY=js overriding settings",
			{ "eval.py": true, "eval.js": true } as Partial<Record<SettingPath, unknown>>,
			"js",
		],
	])("#given eval allowed for %s #when eval loads #then its advertised description does not change", async (_label, overrides, gjcPy) => {
		// given
		if (gjcPy !== undefined) Bun.env.GJC_PY = gjcPy;
		const toolSession = session(overrides);

		// when
		const observed = await descriptionBeforeAndAfterLoad("eval", toolSession);

		// then
		expect(observed).toBeDefined();
		expect(observed?.before).toBe(observed?.after);
	});
});
