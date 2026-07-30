import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import { hooksHandlers, hooksListHandler } from "../../suites/hooks-handlers";

const root = path.resolve(mkdtempSync(path.join(os.tmpdir(), "gjc-hooks-suite-")));
const projectCwd = path.join(root, "project");
const emptyCwd = path.join(root, "empty");
const userConfigName = `.gjc-hooks-suite-${crypto.randomUUID()}`;
const previousConfigDir = process.env.GJC_CONFIG_DIR;
const userHooksRoot = path.join(os.homedir(), userConfigName, "agent", "hooks");
function sha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resultOf(value: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

beforeAll(() => {
	process.env.GJC_CONFIG_DIR = userConfigName;
	mkdirSync(path.join(projectCwd, ".gjc", "hooks", "pre"), { recursive: true });
	mkdirSync(path.join(projectCwd, ".gjc", "hooks", "post"), { recursive: true });
	mkdirSync(path.join(userHooksRoot, "pre"), { recursive: true });
	mkdirSync(emptyCwd, { recursive: true });

	writeFileSync(
		path.join(projectCwd, ".gjc", "hooks", "pre", "prepare.ts"),
		'export default (pi: { on: Function }) => pi.on("tool_call", () => undefined);\n',
	);
	writeFileSync(path.join(projectCwd, ".gjc", "hooks", "post", "deploy.sh"), "#!/bin/sh\necho deploy\n");
	writeFileSync(
		path.join(userHooksRoot, "pre", "review.ts"),
		'export default (pi: { on: Function }) => pi.on("tool_call", () => undefined);\n',
	);
});

afterAll(() => {
	if (previousConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
	else process.env.GJC_CONFIG_DIR = previousConfigDir;
	rmSync(root, { recursive: true, force: true });
	rmSync(path.join(os.homedir(), userConfigName), { recursive: true, force: true });
});

test("HOOK-001 hooks/list projects real native project and user hooks with event, matcher, command, and hash", async () => {
	const params = { cwds: [projectCwd] };
	expect(stableValidators.clientRequestParams["hooks/list"]?.(params)).toBe(true);

	const result = await hooksListHandler(params);
	const payload = resultOf(result) as {
		data: Array<{
			cwd: string;
			hooks: Array<Record<string, unknown>>;
			warnings: string[];
			errors: Array<Record<string, unknown>>;
		}>;
	};
	expect(stableValidators.clientRequestResults["hooks/list"]?.(payload)).toBe(true);
	expect(payload.data).toHaveLength(1);
	expect(payload.data[0]?.cwd).toBe(projectCwd);
	expect(payload.data[0]?.warnings).toEqual([]);
	expect(payload.data[0]?.errors).toEqual([]);

	const projectPrePath = path.join(projectCwd, ".gjc", "hooks", "pre", "prepare.ts");
	const projectPostPath = path.join(projectCwd, ".gjc", "hooks", "post", "deploy.sh");
	const userPrePath = path.join(userHooksRoot, "pre", "review.ts");
	const hooks = payload.data[0]?.hooks ?? [];
	expect(hooks).toHaveLength(3);

	const projectPre = hooks.find(hook => hook.sourcePath === projectPrePath);
	expect(projectPre).toMatchObject({
		eventName: "preToolUse",
		matcher: "prepare",
		command: projectPrePath,
		source: "project",
		currentHash: sha256(projectPrePath),
	});

	const projectPost = hooks.find(hook => hook.sourcePath === projectPostPath);
	expect(projectPost).toMatchObject({
		eventName: "postToolUse",
		matcher: "deploy",
		command: projectPostPath,
		source: "project",
		currentHash: sha256(projectPostPath),
	});

	const userPre = hooks.find(hook => hook.sourcePath === userPrePath);
	expect(userPre).toMatchObject({
		eventName: "preToolUse",
		matcher: "review",
		command: userPrePath,
		source: "user",
		currentHash: sha256(userPrePath),
	});
});

test("HOOK-002 hooks/list reports an empty native configuration as an empty hooks array", async () => {
	const saved = process.env.GJC_CONFIG_DIR;
	const emptyConfigName = `.gjc-hooks-suite-empty-${crypto.randomUUID()}`;
	process.env.GJC_CONFIG_DIR = emptyConfigName;
	try {
		const result = await hooksListHandler({ cwds: [emptyCwd] });
		const payload = resultOf(result) as {
			data: Array<{ cwd: string; hooks: unknown[]; warnings: string[]; errors: unknown[] }>;
		};
		expect(payload.data).toEqual([{ cwd: emptyCwd, hooks: [], warnings: [], errors: [] }]);
	} finally {
		if (saved === undefined) delete process.env.GJC_CONFIG_DIR;
		else process.env.GJC_CONFIG_DIR = saved;
		rmSync(path.join(os.homedir(), emptyConfigName), { recursive: true, force: true });
	}
});

test("HOOK-003 hooks/list rejects malformed pinned params", async () => {
	expect(await hooksListHandler(null)).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await hooksListHandler({ cwds: "not-an-array" })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await hooksListHandler({ cwds: [projectCwd, 42] })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await hooksListHandler({ cwds: [""] })).toEqual({ ok: false, errorKey: "invalidParams" });
});

test("HOOK-004 hooks lane exposes only the genuinely backed request method", () => {
	expect(Object.keys(hooksHandlers)).toEqual(["hooks/list"]);
});
