import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { YAML } from "bun";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import {
	DEFAULT_SESSION_OWNERSHIP_MODE,
	resolveSessionOwnershipMode,
	SESSION_OWNERSHIP_MODES,
	type SessionOwnershipMode,
	sessionOwnershipMode,
	sessionOwnershipTestHookSlot,
	trustedSessionOwnershipOverride,
} from "../../src/session/session-ownership-mode";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ownership-mode-")));
	roots.push(root);
	return root;
}

afterEach(async () => {
	resetSettingsForTest();
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

describe("the session.ownership setting", () => {
	async function initSettings(global: unknown, project: unknown, overrides?: Record<string, unknown>) {
		const root = await tempRoot();
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(global));
		await Bun.write(path.join(cwd, ".gjc", "settings.json"), JSON.stringify(project));
		return Settings.init({ cwd, agentDir, overrides });
	}

	it("defaults to off, with or without process settings", async () => {
		expect(sessionOwnershipTestHookSlot().mode).toBeUndefined();
		expect(sessionOwnershipMode()).toBe("off");
		const settings = await initSettings({}, {});
		expect(settings.get("session.ownership")).toBe("off");
		expect(sessionOwnershipMode()).toBe("off");
	});

	it("is global-only: project files and runtime overrides cannot set it", async () => {
		const settings = await initSettings(
			{ session: { ownership: "observe" } },
			{ session: { ownership: "enforce" } },
			{ "session.ownership": "off" },
		);
		expect(settings.get("session.ownership")).toBe("observe");
		expect(sessionOwnershipMode()).toBe("observe");
	});

	it("the schema lists exactly the modes the resolver knows, with the same default", () => {
		expect(SETTINGS_SCHEMA["session.ownership"].values).toEqual([...SESSION_OWNERSHIP_MODES]);
		expect<string>(SETTINGS_SCHEMA["session.ownership"].default).toBe(DEFAULT_SESSION_OWNERSHIP_MODE);
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

	it("cannot be raised from a project file when the user left it at off", async () => {
		await initSettings({}, { session: { ownership: "enforce" } });
		expect(sessionOwnershipMode()).toBe("off");
	});
});
