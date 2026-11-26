import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { YAML } from "bun";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import {
	DEFAULT_SESSION_OWNERSHIP_MODE,
	resetSessionOwnershipModeForTests,
	resolveSessionOwnershipMode,
	SESSION_OWNERSHIP_MODES,
	type SessionOwnershipMode,
	sessionOwnershipMode,
	sessionOwnershipModeFor,
	sessionOwnershipOverrideWasRead,
	sessionOwnershipTestHookSlot,
	trustedSessionOwnershipOverride,
} from "../../src/session/session-ownership-mode";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ownership-mode-")));
	roots.push(root);
	return root;
}

// The override is read once per process, so each test starts with it unset and unread.
const operatorOverride = process.env.GJC_SESSION_OWNERSHIP;
let debugLines: string[] = [];

beforeEach(() => {
	delete process.env.GJC_SESSION_OWNERSHIP;
	resetSessionOwnershipModeForTests();
	debugLines = [];
	vi.spyOn(logger, "debug").mockImplementation(message => {
		debugLines.push(message);
	});
});

afterEach(async () => {
	resetSettingsForTest();
	resetSessionOwnershipModeForTests();
	vi.restoreAllMocks();
	if (operatorOverride === undefined) delete process.env.GJC_SESSION_OWNERSHIP;
	else process.env.GJC_SESSION_OWNERSHIP = operatorOverride;
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("resolveSessionOwnershipMode", () => {
	it("takes the setting, and lets the override only lower it", () => {
		const cases: [unknown, string | undefined, SessionOwnershipMode][] = [
			[undefined, undefined, "off"],
			["observe", undefined, "observe"],
			["enforce", undefined, "enforce"],
			["enforce", "observe", "observe"],
			["enforce", " OFF ", "off"],
			["observe", "off", "off"],
			// Never raised.
			["off", "enforce", "off"],
			["observe", "enforce", "observe"],
			// An invalid setting reads as the default; an invalid override is ignored.
			["on", undefined, "off"],
			[true, "observe", "off"],
			["enforce", "disabled", "enforce"],
		];
		for (const [setting, override, expected] of cases)
			expect([setting, override, resolveSessionOwnershipMode(setting, override)]).toEqual([
				setting,
				override,
				expected,
			]);
	});
});

describe("GJC_SESSION_OWNERSHIP provenance", () => {
	it("ignores a value the project .env supplied, and honours one the operator set", async () => {
		const project = await tempRoot();
		await Bun.write(path.join(project, ".env"), "GJC_SESSION_OWNERSHIP=off\nNODE_ENV=test\n");
		const snapshot = projectEnvSnapshot(project);
		expect(trustedSessionOwnershipOverride({ GJC_SESSION_OWNERSHIP: "off" }, snapshot)).toBeUndefined();
		expect(trustedSessionOwnershipOverride({ GJC_SESSION_OWNERSHIP: "observe" }, snapshot)).toBe("observe");
		expect(trustedSessionOwnershipOverride({}, snapshot)).toBeUndefined();
	});

	it("ignores a project value Bun expands, and any value when the snapshot is incomplete", async () => {
		const project = await tempRoot();
		await Bun.write(path.join(project, ".env"), "GJC_SESSION_OWNERSHIP=$LEVEL\n");
		expect(trustedSessionOwnershipOverride({ GJC_SESSION_OWNERSHIP: "off" }, projectEnvSnapshot(project))).toBe(
			undefined,
		);
		const incomplete = { values: {}, dynamic: new Set<string>(), incomplete: true as const };
		expect(trustedSessionOwnershipOverride({ GJC_SESSION_OWNERSHIP: "off" }, incomplete)).toBeUndefined();
	});
});

describe("the session.ownership.mode setting", () => {
	type Surface = "settings.json" | "config.yml";
	async function initSettings(
		global: unknown,
		project: unknown,
		overrides?: Record<string, unknown>,
		surface: Surface = "settings.json",
	) {
		const root = await tempRoot();
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(global));
		const projectFile = path.join(cwd, ".gjc", surface);
		await Bun.write(projectFile, surface === "settings.json" ? JSON.stringify(project) : YAML.stringify(project));
		return Settings.init({ cwd, agentDir, overrides });
	}
	const userEnforce = { session: { ownership: { mode: "enforce" } } };

	it("defaults to off, with or without process settings", async () => {
		expect(sessionOwnershipTestHookSlot().mode).toBeUndefined();
		expect(sessionOwnershipMode()).toBe("off");
		const settings = await initSettings({}, {});
		expect(settings.get("session.ownership.mode")).toBe("off");
		expect(sessionOwnershipMode()).toBe("off");
	});

	it("is global-only: project files and runtime overrides cannot set it", async () => {
		const settings = await initSettings(
			{ session: { ownership: { mode: "observe" } } },
			{ session: { ownership: { mode: "enforce" } } },
			{ "session.ownership.mode": "off" },
		);
		expect(settings.get("session.ownership.mode")).toBe("observe");
		expect(sessionOwnershipMode()).toBe("observe");
	});

	it("a null or scalar session parent in a project file or a runtime override does not lower it", async () => {
		const parents: unknown[] = [null, "x", [], 1, { ownership: null }, { ownership: "off" }];
		for (const parent of parents) {
			for (const surface of ["settings.json", "config.yml"] as const) {
				await initSettings(userEnforce, { session: parent }, undefined, surface);
				expect([surface, parent, sessionOwnershipMode()]).toEqual([surface, parent, "enforce"]);
				resetSettingsForTest();
			}
			await initSettings(userEnforce, {}, { session: parent });
			expect(["overrides", parent, sessionOwnershipMode()]).toEqual(["overrides", parent, "enforce"]);
			resetSettingsForTest();
			const settings = await initSettings(userEnforce, {});
			settings.override("session" as never, parent as never);
			expect(["override()", parent, sessionOwnershipMode()]).toEqual(["override()", parent, "enforce"]);
			resetSettingsForTest();
		}
	});

	it("covers the whole session.ownership namespace as global-only", async () => {
		const settings = await initSettings(userEnforce, { session: { ownership: { mode: "off", laterFlag: true } } });
		const resolution = settings.getResolutionSnapshot()["session.ownership.mode"];
		expect(resolution.allowedLayers).toEqual(["global"]);
		expect(sessionOwnershipMode()).toBe("enforce");
	});

	it("the schema lists exactly the modes the resolver knows, with the same default", () => {
		expect(SETTINGS_SCHEMA["session.ownership.mode"].values).toEqual([...SESSION_OWNERSHIP_MODES]);
		expect<string>(SETTINGS_SCHEMA["session.ownership.mode"].default).toBe(DEFAULT_SESSION_OWNERSHIP_MODE);
	});

	it("is not a public import path, so an embedder cannot replace the setting source", async () => {
		const manifest = (await Bun.file(path.join(import.meta.dir, "../../package.json")).json()) as {
			exports: Record<string, unknown>;
		};
		expect(manifest.exports["./session/session-ownership-mode"]).toBeNull();
		expect(manifest.exports["./session/session-ownership-mode.js"]).toBeNull();
		// Resolving the `.js` spelling as well never returns under Bun 1.4.0 in this file; the
		// manifest entries above cover it.
		expect(() =>
			Bun.resolveSync("@gajae-code/coding-agent/session/session-ownership-mode", import.meta.dir),
		).toThrow();
	});

	/** Run `check` with the process agent dir at a fresh one whose config.yml is `config` (or, for "unreadable", a directory). */
	async function withOperatorConfig(config: unknown, check: () => void): Promise<void> {
		const agentDir = path.join(await tempRoot(), "agent");
		await fs.mkdir(agentDir, { recursive: true });
		if (config === "unreadable") await fs.mkdir(path.join(agentDir, "config.yml"));
		else await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(config));
		const previous = process.env.GJC_CODING_AGENT_DIR;
		setAgentDir(agentDir);
		try {
			check();
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
			resetSettingsForTest();
		}
	}
	const isolatedMode = (mode?: string) =>
		sessionOwnershipModeFor(
			Settings.isolated(mode === undefined ? {} : { "session.ownership.mode": mode }).getGlobal(
				"session.ownership.mode",
			),
		);
	const fileMode = (mode: SessionOwnershipMode) => ({ session: { ownership: { mode } } });

	it("without Settings.init, the operator's config file decides, for isolated settings too", async () => {
		await withOperatorConfig(fileMode("observe"), () => {
			// An embedding's settings never loaded config.yml, so they carry no value of their own.
			expect(isolatedMode()).toBe("observe");
			expect(sessionOwnershipMode()).toBe("observe");
		});
	});

	it("a valid explicit value in isolated settings wins; an invalid one falls back to the config file", async () => {
		await withOperatorConfig(fileMode("off"), () => expect(isolatedMode("observe")).toBe("observe"));
		await withOperatorConfig(fileMode("observe"), () => expect(isolatedMode("bogus")).toBe("observe"));
	});

	it("an unreadable config file resolves to off, and says so once", async () => {
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(message => {
			warnings.push(message);
		});
		await withOperatorConfig("unreadable", () => {
			expect(isolatedMode()).toBe("off");
			expect(sessionOwnershipMode()).toBe("off");
		});
		expect(warnings).toEqual(["Session ownership is off: the global config could not be read"]);
	});

	it("cannot be raised from a project file when the user left it at off", async () => {
		await initSettings({}, { session: { ownership: { mode: "enforce" } } });
		expect(sessionOwnershipMode()).toBe("off");
	});
});

describe("GJC_SESSION_OWNERSHIP at run time", () => {
	async function userMode(mode: SessionOwnershipMode) {
		const root = await tempRoot();
		await fs.mkdir(path.join(root, "agent"), { recursive: true });
		await Bun.write(path.join(root, "agent", "config.yml"), YAML.stringify({ session: { ownership: { mode } } }));
		return Settings.init({ cwd: root, agentDir: path.join(root, "agent") });
	}

	it("off returns before the environment is read at all", async () => {
		process.env.GJC_SESSION_OWNERSHIP = "enforce";
		await userMode("off");
		expect(sessionOwnershipMode()).toBe("off");
		expect(sessionOwnershipOverrideWasRead()).toBe(false);
		expect(debugLines).toEqual([]);
		resetSettingsForTest();
		await userMode("observe");
		expect(sessionOwnershipMode()).toBe("observe");
		expect(sessionOwnershipOverrideWasRead()).toBe(true);
	});

	it("an operator override lowers the mode", async () => {
		process.env.GJC_SESSION_OWNERSHIP = "off";
		await userMode("enforce");
		expect(sessionOwnershipMode()).toBe("off");
		expect(debugLines).toEqual([]);
	});

	it("a request to raise the mode, or an invalid value, is ignored with one debug line", async () => {
		process.env.GJC_SESSION_OWNERSHIP = "enforce";
		await userMode("observe");
		expect(sessionOwnershipMode()).toBe("observe");
		expect(sessionOwnershipMode()).toBe("observe");
		expect(debugLines).toEqual(["GJC_SESSION_OWNERSHIP ignored: it can only lower the configured mode"]);

		resetSettingsForTest();
		resetSessionOwnershipModeForTests();
		debugLines = [];
		process.env.GJC_SESSION_OWNERSHIP = "disabled";
		await userMode("enforce");
		expect(sessionOwnershipMode()).toBe("enforce");
		expect(debugLines).toEqual(["GJC_SESSION_OWNERSHIP ignored: its value is not off, observe or enforce"]);
	});

	it("in a real process, a project .env cannot lower the mode, and the operator's value can", async () => {
		const root = await tempRoot();
		const project = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(project, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(project, ".env"), "GJC_SESSION_OWNERSHIP=off\n");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ session: { ownership: { mode: "enforce" } } }),
		);
		const script = path.join(root, "print-mode.ts");
		const src = path.join(import.meta.dir, "../../src");
		await Bun.write(
			script,
			[
				`import { Settings } from ${JSON.stringify(path.join(src, "config/settings.ts"))};`,
				`import { sessionOwnershipMode } from ${JSON.stringify(path.join(src, "session/session-ownership-mode.ts"))};`,
				`await Settings.init({ cwd: process.cwd(), agentDir: ${JSON.stringify(agentDir)} });`,
				"console.log('MODE=' + sessionOwnershipMode());",
				"process.exit(0);",
			].join("\n"),
		);
		const run = async (operator: string | undefined) => {
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: root,
				TMPDIR: root,
				GJC_CODING_AGENT_DIR: agentDir,
				XDG_CONFIG_HOME: path.join(root, "xdg"),
				XDG_STATE_HOME: path.join(root, "xdg"),
				XDG_DATA_HOME: path.join(root, "xdg"),
				XDG_CACHE_HOME: path.join(root, "xdg"),
				GJC_LOG_DIR: path.join(root, "logs"),
			};
			if (operator !== undefined) env.GJC_SESSION_OWNERSHIP = operator;
			const child = Bun.spawn([process.execPath, script], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
			const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
			await child.exited;
			return out.match(/MODE=(\w+)/)?.[1] ?? `no mode (exit ${child.exitCode}): ${err.slice(0, 300)}`;
		};
		// Bun copies the project .env into process.env; that value must not count.
		expect(await run(undefined)).toBe("enforce");
		// The operator's own value differs from the project's, so it counts.
		expect(await run("observe")).toBe("observe");
	}, 60_000);
});
