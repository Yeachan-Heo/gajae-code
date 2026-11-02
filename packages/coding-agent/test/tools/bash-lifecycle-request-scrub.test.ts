import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { disposeAllShellSessions, executeBash } from "../../src/exec/bash-executor";
import * as masterCli from "../../src/sdk/cli/master-cli";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

const REQUEST = "GJC_LIFECYCLE_REQUEST_ID";
const SESSION = "GJC_SESSION_ID";

const PROBE = [
	`req=$(printenv ${REQUEST} 2>/dev/null || printf '<unset>')`,
	`sid=$(printenv ${SESSION} 2>/dev/null || printf '<unset>')`,
	`if [ -n "$(printenv ${REQUEST} 2>/dev/null || true)" ]; then printf 'decision=ADOPT\\n'; else printf 'decision=FRESH\\n'; fi`,
	`printf '${REQUEST}=%s\\n' "$req"`,
	`printf '${SESSION}=%s\\n' "$sid"`,
].join("\n");

function textOf(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
	return content.find(block => block.type === "text")?.text ?? "";
}

function createSession(sessionId: string, cwd: string): ToolSession {
	return {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getMasterOwnerSessionId: () => undefined,
		settings: {
			has: () => false,
			get: () => undefined,
			getBashInterceptorRules: () => [],
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;
}

async function withRequest<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
	const previous = process.env[REQUEST];
	if (value === undefined) delete process.env[REQUEST];
	else process.env[REQUEST] = value;
	try {
		return await body();
	} finally {
		if (previous === undefined) delete process.env[REQUEST];
		else process.env[REQUEST] = previous;
	}
}

describe("lifecycle request id is not inherited by bash", () => {
	let cwd = "";

	afterEach(async () => {
		await disposeAllShellSessions();
		if (cwd) await rm(cwd, { recursive: true, force: true });
		cwd = "";
	});

	async function temp(): Promise<string> {
		cwd = await mkdtemp(join(tmpdir(), "gjc-bash-life-"));
		return cwd;
	}

	it("nested bash does not adopt the parent session id", async () => {
		const dir = await temp();
		const sessionId = "parent-session-id";
		const output = await withRequest("lifecycle-marker", async () => {
			const result = await new BashTool(createSession(sessionId, dir)).execute("call", {
				command: PROBE,
				cwd: dir,
			});
			return textOf(result);
		});
		expect(output).toContain("decision=FRESH");
		expect(output).toContain(`${REQUEST}=<unset>`);
		expect(output).toContain(`${SESSION}=${sessionId}`);
	});

	it("keeps shell functions when the explicit request id changes", async () => {
		const dir = await temp();
		const settings = {
			has: () => false,
			get: () => undefined,
			...stubBashExecutorSettings,
		} as never;
		const common = {
			cwd: dir,
			sessionKey: "persist-life",
			disableShellSnapshot: true,
			timeout: 30_000,
			settings,
		};
		await withRequest("ambient-marker", async () => {
			const defined = await executeBash("review_fn() { printf preserved; }; review_fn", {
				...common,
				env: {},
			});
			const marked = await executeBash(
				`review_fn; req=$(printenv ${REQUEST} 2>/dev/null || printf '<unset>'); printf ' req=%s' "$req"`,
				{ ...common, env: { [REQUEST]: " explicit-marker " } },
			);
			const again = await executeBash(
				`review_fn; req=$(printenv ${REQUEST} 2>/dev/null || printf '<unset>'); printf ' req=%s' "$req"`,
				{ ...common, env: {} },
			);
			expect(defined.exitCode).toBe(0);
			expect(defined.output).toContain("preserved");
			expect(marked.exitCode).toBe(0);
			expect(marked.output).toContain("preserved");
			expect(marked.output).toContain("req= explicit-marker ");
			expect(again.exitCode).toBe(0);
			expect(again.output).toContain("preserved");
			expect(again.output).toContain("req=<unset>");
		});
	});

	it("keeps an explicit request id and a normal session id", async () => {
		const dir = await temp();
		const output = await withRequest("ambient-marker", async () => {
			const result = await new BashTool(createSession("kept-session", dir)).execute("call", {
				command: PROBE,
				cwd: dir,
				env: { [REQUEST]: " explicit-marker " },
			});
			return textOf(result);
		});
		expect(output).toContain("decision=ADOPT");
		expect(output).toContain(`${REQUEST}= explicit-marker `);
		expect(output).toContain(`${SESSION}=kept-session`);
	});

	it("direct master spawn drops ambient and explicit request ids from runSdkSpawn", async () => {
		const dir = await temp();
		let seen: Record<string, string> | undefined;
		const spy = spyOn(masterCli, "runSdkSpawn").mockImplementation((async (_args, deps) => {
			const env = (deps as { env?: Record<string, string> } | undefined)?.env;
			seen = env ? { ...env } : {};
			return { exitCode: 0, rendered: { code: "ok" } };
		}) as never);
		try {
			await withRequest("ambient-marker", async () => {
				const session = createSession("master-session", dir);
				(session as { getMasterBashCapability: () => string }).getMasterBashCapability = () =>
					"master-capability-fixture";
				(session as { getMasterOwnerSessionId: () => string }).getMasterOwnerSessionId = () => "master-owner";
				(session as { getSessionAgentDir: () => string }).getSessionAgentDir = () => dir;
				await new BashTool(session).execute("call", {
					command: "gjc sdk spawn --cwd /tmp --prompt task",
					cwd: dir,
					env: { [REQUEST]: " explicit-marker " },
				});
			});
			expect(seen?.[REQUEST]).toBeUndefined();
			expect(JSON.stringify(seen ?? {})).not.toContain("ambient-marker");
			expect(JSON.stringify(seen ?? {})).not.toContain("explicit-marker");
		} finally {
			spy.mockRestore();
		}
	});

	it("executeBash drops an inherited request id from the child", async () => {
		const dir = await temp();
		const output = await withRequest("sibling-marker", async () => {
			const result = await executeBash(PROBE, {
				cwd: dir,
				oneShot: true,
				timeout: 30_000,
				settings: {
					has: () => false,
					get: () => undefined,
					...stubBashExecutorSettings,
				} as never,
				env: { [SESSION]: "exec-session" },
			});
			return result.output;
		});
		expect(output).toContain("decision=FRESH");
		expect(output).toContain(`${REQUEST}=<unset>`);
		expect(output).toContain(`${SESSION}=exec-session`);
	});

	it("two overlapping bash runs both drop the request id", async () => {
		const outputs = await withRequest("shared-marker", async () => {
			const runs = ["owner-a", "owner-b"].map(async id => {
				const own = await mkdtemp(join(tmpdir(), "gjc-bash-life-"));
				try {
					const result = await new BashTool(createSession(id, own)).execute("call", {
						command: PROBE,
						cwd: own,
					});
					return textOf(result);
				} finally {
					await rm(own, { recursive: true, force: true });
				}
			});
			return Promise.all(runs);
		});
		expect(outputs[0]).toContain("decision=FRESH");
		expect(outputs[0]).toContain(`${SESSION}=owner-a`);
		expect(outputs[1]).toContain("decision=FRESH");
		expect(outputs[1]).toContain(`${SESSION}=owner-b`);
		expect(outputs[0]).not.toContain("owner-b");
		expect(outputs[1]).not.toContain("owner-a");
	});

	it("property: any inherited request value stays unset in the child", async () => {
		const dir = await temp();
		await fc.assert(
			fc.asyncProperty(fc.string({ maxLength: 40 }), async value => {
				const output = await withRequest(value, async () => {
					const result = await new BashTool(createSession("prop-session", dir)).execute("call", {
						command: PROBE,
						cwd: dir,
					});
					return textOf(result);
				});
				expect(output).toContain(`${REQUEST}=<unset>`);
				expect(output).toContain("decision=FRESH");
				expect(output).toContain(`${SESSION}=prop-session`);
			}),
			{ seed: 47118, numRuns: 64 },
		);
	}, 120_000);
});
