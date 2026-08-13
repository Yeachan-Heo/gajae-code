import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import { getConfigDirs } from "@gajae-code/coding-agent/config";
import { getUserPath } from "@gajae-code/coding-agent/discovery/helpers";

describe("PI_CONFIG_DIR", () => {
	const original = process.env.PI_CONFIG_DIR;
	const originalGjc = process.env.GJC_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = original;
		}
		if (originalGjc === undefined) {
			delete process.env.GJC_CONFIG_DIR;
		} else {
			process.env.GJC_CONFIG_DIR = originalGjc;
		}
	});

	test("getUserPath uses PI_CONFIG_DIR for native userAgent", () => {
		delete process.env.GJC_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = ".config/gjc";
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		const result = getUserPath(ctx, "native", "commands");
		expect(result).toBe(path.join(ctx.home, ".config/gjc/agent", "commands"));
	});

	test("getConfigDirs respects PI_CONFIG_DIR for user base", () => {
		delete process.env.GJC_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = ".config/gjc";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/gjc", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".gjc", level: "user" });
	});
	test("getConfigDirs excludes Claude and Codex config roots", () => {
		const userDirs = getConfigDirs("", { project: false }).map(entry => entry.source);
		const projectDirs = getConfigDirs("", { user: false, project: true, cwd: "/work/project" }).map(
			entry => entry.source,
		);

		expect(userDirs).not.toContain(".claude");
		expect(userDirs).not.toContain(".codex");
		expect(projectDirs).not.toContain(".claude");
		expect(projectDirs).not.toContain(".codex");
	});
});
