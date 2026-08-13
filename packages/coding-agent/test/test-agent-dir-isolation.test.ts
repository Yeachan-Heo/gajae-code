/**
 * Test-process agent-directory isolation decision (scripts/test-agent-dir-isolation.ts).
 *
 * The preload that consumes this decision is what keeps `bun test` from writing
 * into the operator's live `~/.gjc/agent`. The decision is unit-tested here
 * because importing the preload would apply its environment mutations.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	decideAgentDirIsolation,
	defaultAgentDirFor,
	readProjectEnvFile,
} from "../../../scripts/test-agent-dir-isolation";

const HOME = "/home/operator";
const DEFAULT_AGENT_DIR = path.join(HOME, ".gjc", "agent");
/** No path in these unit cases exists on disk, so realpath must not decide anything. */
const noRealpath = (target: string): string => {
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path: target });
};

describe("test agent-dir isolation decision", () => {
	test("isolates when no override is present", () => {
		expect(decideAgentDirIsolation({ home: HOME, env: {}, projectEnv: {}, realpath: noRealpath })).toEqual({
			action: "isolate",
			reason: "absent",
		});
	});

	test("isolates an ambient override that only restates the default agent dir", () => {
		// A gjc parent process exports this into every child it spawns, so
		// equality with the default carries no test intent.
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: DEFAULT_AGENT_DIR },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates a PI-only ambient override that restates the default", () => {
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { PI_CODING_AGENT_DIR: DEFAULT_AGENT_DIR },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates a default restated under a custom config dir name", () => {
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CONFIG_DIR: ".qa-gjc", GJC_CODING_AGENT_DIR: path.join(HOME, ".qa-gjc", "agent") },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates a symlinked spelling of the default agent dir", () => {
		const canonical = "/canonical/agent";
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: "/link/to/agent" },
				projectEnv: {},
				realpath: () => canonical,
			}),
		).toEqual({ action: "isolate", reason: "default" });
	});

	test("isolates an override planted by the project .env even when non-default", () => {
		// Production `getAgentDir()` refuses a project-.env-sourced override, so
		// honoring it here would isolate nothing while production resolved the
		// live default directory.
		const planted = "/repo/shipped-agent-dir";
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: planted },
				projectEnv: { GJC_CODING_AGENT_DIR: planted },
				realpath: noRealpath,
			}),
		).toEqual({ action: "isolate", reason: "untrusted" });
	});

	test("honors an explicit trusted non-default pin", () => {
		expect(
			decideAgentDirIsolation({
				home: HOME,
				env: { GJC_CODING_AGENT_DIR: "/tmp/pinned-agent" },
				projectEnv: {},
				realpath: noRealpath,
			}),
		).toEqual({ action: "honor", agentDir: "/tmp/pinned-agent" });
	});

	test("a project-.env config dir name does not move the computed default", () => {
		// The name is distrusted, so the default stays under `.gjc` and an ambient
		// `.gjc/agent` override is still recognized as the default.
		expect(defaultAgentDirFor(HOME, { GJC_CONFIG_DIR: ".planted" }, { GJC_CONFIG_DIR: ".planted" })).toBe(
			DEFAULT_AGENT_DIR,
		);
	});

	test("an escaping config dir name falls back to the default name", () => {
		expect(defaultAgentDirFor(HOME, { GJC_CONFIG_DIR: "../escape" }, {})).toBe(DEFAULT_AGENT_DIR);
	});
});

describe("project .env reader", () => {
	test("parses assignments, strips quotes, and ignores comments", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-envread-"));
		try {
			await fs.promises.writeFile(
				path.join(dir, ".env"),
				["# comment", 'GJC_CODING_AGENT_DIR="/quoted/dir"', "PI_CONFIG_DIR=.plain", "MALFORMED", ""].join("\n"),
			);
			expect(readProjectEnvFile(dir)).toEqual({
				GJC_CODING_AGENT_DIR: "/quoted/dir",
				PI_CONFIG_DIR: ".plain",
			});
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("a missing .env is an empty record, never a throw", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-envread-missing-"));
		try {
			expect(readProjectEnvFile(dir)).toEqual({});
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
