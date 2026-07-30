import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import type { HandlerContext } from "../../suites/handlers";
import {
	skillsConfigWriteHandler,
	skillsExtraRootsSetHandler,
	skillsHandlers,
	skillsListHandler,
} from "../../suites/skills-handlers";

type Notification = { method: string; params: Record<string, unknown> };

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "gjc-skills-suite-"));
const agentDir = path.join(tempRoot, "agent");
const workspace = path.join(tempRoot, "workspace");
const extraRoot = path.join(tempRoot, "extra-skills");
const previousAgentDir = process.env.GJC_AGENT_DIR;
const previousCwd = process.cwd();

function writeSkill(root: string, name: string, description: string): string {
	const skillDir = path.join(root, name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = path.join(skillDir, "SKILL.md");
	writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
	return skillPath;
}

function contextFor(notifications: Notification[]): HandlerContext {
	return {
		connectionId: `skills-test-${crypto.randomUUID()}`,
		emitTo: (_connectionId, method, params) => {
			if (typeof params === "object" && params !== null && !Array.isArray(params)) {
				notifications.push({ method, params: params as Record<string, unknown> });
			}
		},
	};
}

function resultOf(value: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

beforeAll(() => {
	process.env.GJC_AGENT_DIR = agentDir;
	mkdirSync(workspace, { recursive: true });
	process.chdir(workspace);
	mkdirSync(agentDir, { recursive: true });
	writeSkill(path.join(workspace, ".gjc", "skills"), "project-alpha", "Project alpha skill");
	writeFileSync(
		path.join(agentDir, "config.yml"),
		YAML.stringify(
			{
				skills: {
					enabled: true,
					enablePiProject: true,
					enablePiUser: false,
				},
			},
			null,
			2,
		),
	);
});

afterAll(() => {
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
});

test("SK-001 skills/list enumerates a real project SKILL.md with pinned metadata", async () => {
	const params = { cwds: [workspace], forceReload: true };
	expect(stableValidators.clientRequestParams["skills/list"]?.(params)).toBe(true);
	const result = await skillsListHandler(params);
	const payload = resultOf(result) as { data: Array<Record<string, unknown>> };
	expect(stableValidators.clientRequestResults["skills/list"]?.(payload)).toBe(true);
	expect(payload.data).toHaveLength(1);
	const entry = payload.data[0] as {
		cwd: string;
		skills: Array<Record<string, unknown>>;
		errors: unknown[];
	};
	expect(entry.cwd).toBe(path.resolve(workspace));
	expect(entry.errors).toEqual([]);
	expect(entry.skills).toContainEqual({
		name: "project-alpha",
		description: "Project alpha skill",
		path: path.join(workspace, ".gjc", "skills", "project-alpha", "SKILL.md"),
		scope: "repo",
		enabled: true,
	});
});

test("SK-002 skills/config/write persists per-skill enablement and emits skills/changed", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const disabled = await skillsConfigWriteHandler({ name: "project-alpha", enabled: false }, context);
	expect(disabled).toEqual({ ok: true, result: { effectiveEnabled: false } });
	if (disabled.ok) expect(stableValidators.clientRequestResults["skills/config/write"]?.(disabled.result)).toBe(true);
	expect(readFileSync(path.join(agentDir, "config.yml"), "utf8")).toContain("disabledExtensions:");
	expect(notifications.filter(notification => notification.method === "skills/changed")).toHaveLength(1);
	expect(stableValidators.serverNotificationParams["skills/changed"]?.({})).toBe(true);

	const reenabled = await skillsConfigWriteHandler({ name: "project-alpha", enabled: true }, context);
	expect(reenabled).toEqual({ ok: true, result: { effectiveEnabled: true } });
	expect(notifications.filter(notification => notification.method === "skills/changed")).toHaveLength(2);
});

test("SK-003 skills/config/write toggles the global discovery setting and rejects unknown keys", async () => {
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const disabled = await skillsConfigWriteHandler({ enabled: false }, context);
	expect(disabled).toEqual({ ok: true, result: { effectiveEnabled: false } });
	expect(notifications.filter(notification => notification.method === "skills/changed")).toHaveLength(1);
	const enabled = await skillsConfigWriteHandler({ enabled: true }, context);
	expect(enabled).toEqual({ ok: true, result: { effectiveEnabled: true } });
	expect(notifications.filter(notification => notification.method === "skills/changed")).toHaveLength(2);
	expect(await skillsConfigWriteHandler({ enabled: true, unknown: false })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
});

test("SK-004 skills/extraRoots/set persists a real root and exposes its skill on the next list", async () => {
	writeSkill(extraRoot, "extra-alpha", "Extra root skill");
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const params = { extraRoots: [extraRoot] };
	expect(stableValidators.clientRequestParams["skills/extraRoots/set"]?.(params)).toBe(true);
	const written = await skillsExtraRootsSetHandler(params, context);
	expect(written).toEqual({ ok: true, result: {} });
	if (written.ok) expect(stableValidators.clientRequestResults["skills/extraRoots/set"]?.(written.result)).toBe(true);
	expect(notifications.filter(notification => notification.method === "skills/changed")).toHaveLength(1);

	const listed = resultOf(await skillsListHandler({ cwds: [workspace], forceReload: true })) as {
		data: Array<{ skills: Array<Record<string, unknown>> }>;
	};
	expect(listed.data[0]?.skills).toContainEqual({
		name: "extra-alpha",
		description: "Extra root skill",
		path: path.join(extraRoot, "extra-alpha", "SKILL.md"),
		scope: "user",
		enabled: true,
	});
	const noopNotifications: Notification[] = [];
	expect(await skillsExtraRootsSetHandler(params, contextFor(noopNotifications))).toEqual({ ok: true, result: {} });
	expect(noopNotifications).toEqual([]);
});

test("SK-005 skills/extraRoots/set rejects relative, missing, and file roots", async () => {
	const filePath = path.join(tempRoot, "not-a-root.txt");
	writeFileSync(filePath, "not a directory");
	for (const invalid of ["relative/root", path.join(tempRoot, "missing"), filePath]) {
		expect(await skillsExtraRootsSetHandler({ extraRoots: [invalid] })).toEqual({
			ok: false,
			errorKey: "invalidParams",
		});
	}
});

test("SK-006 skillsHandlers exposes exactly the three client-request methods", () => {
	expect(Object.keys(skillsHandlers).sort()).toEqual(["skills/config/write", "skills/extraRoots/set", "skills/list"]);
});
