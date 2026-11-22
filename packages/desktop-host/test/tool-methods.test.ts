import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../src/protocol";
import { parseRequest } from "../src/protocol";
import { TOOL_DETAIL_GONE } from "../src/tool-projection";
import { DESKTOP_TOOL_LIMITS, type DesktopToolDetail, type DesktopToolList } from "../src/tool-protocol";

describe("desktop tool methods on a live session", () => {
	let environment: NodeJS.ProcessEnv;
	let agentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	const spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		environment = { ...process.env };
		agentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		spies.push(vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined));
	});
	afterEach(async () => {
		try {
			for (const cleanup of cleanups.splice(0)) await cleanup();
		} finally {
			for (const spy of spies.splice(0)) spy.mockRestore();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(agentDir);
		}
	});

	async function fixture() {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-tools-")));
		const dataDir = path.join(directory, "app");
		const projectDir = path.join(directory, "project");
		await fs.mkdir(projectDir);
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		const frames: DesktopFrame[] = [];
		const sessions: CreateAgentSessionResult[] = [];
		const host = new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				const result = await createAgentSession(options);
				sessions.push(result);
				return result;
			},
		});
		cleanups.push(async () => {
			await host.close();
			await Promise.all(sessions.map(result => result.session.awaitDisposeCompletion()));
			await fs.rm(directory, { recursive: true, force: true });
		});
		const respond = async (method: DesktopRequest["method"], params: Record<string, unknown>) => {
			const id = crypto.randomUUID();
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing response");
			return response;
		};
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}) => {
			const response = await respond(method, params);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		return { call, respond, session, sdk: sessions[0]!.session };
	}

	test("tools.list returns the session's SDK tool names", async () => {
		const h = await fixture();
		const result = await h.call<{ available: string[]; active: string[] }>("tools.list", {
			sessionId: h.session.id,
		});
		expect(result).toMatchObject({ available: h.sdk.getAllToolNames(), active: h.sdk.getActiveToolNames() });
		expect(result.active.length).toBeGreaterThan(0);
	}, 30_000);

	test("tool.detail refuses an unknown call without echoing it and requires a call id", async () => {
		const h = await fixture();
		const response = await h.respond("tool.detail", { sessionId: h.session.id, callId: "toolu_unknown" });
		expect(response).toMatchObject({ ok: false, error: TOOL_DETAIL_GONE });
		expect("result" in response).toBe(false);
		expect(JSON.stringify(response)).not.toContain("toolu_unknown");
		expect(await h.respond("tool.detail", { sessionId: h.session.id })).toMatchObject({
			ok: false,
			error: "Invalid callId",
		});
	}, 30_000);

	test("tool.detail returns the full call, redacted by the Host's own credentials before its bounds", async () => {
		const h = await fixture();
		// A credential the Host learns about; JSON would escape its quote and backslash.
		const secret = 'sk-"quoted\\credential-1234567890';
		await h.respond("auth.setKey", { provider: "unknown-provider", key: secret });
		h.sdk.agent.replaceMessages([
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{
						type: "toolCall",
						id: "toolu_bash",
						name: "bash",
						arguments: {
							command: `curl -H "Authorization: ${secret}" https://example.invalid\necho done`,
							env: { API_TOKEN: secret },
							cwd: "packages/app",
							_i: "Call the service",
						},
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "toolu_bash",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 1,
			},
		] as never);
		const detail = await h.call<DesktopToolDetail>("tool.detail", { sessionId: h.session.id, callId: "toolu_bash" });
		expect(detail.callId).toBe("toolu_bash");
		expect(detail.command).toBe('curl -H "Authorization: [redacted]" https://example.invalid\necho done');
		expect(JSON.parse(detail.args!)).toEqual({ env: { API_TOKEN: "[redacted]" }, cwd: "packages/app" });
		expect(JSON.stringify(detail)).not.toContain("credential-1234567890");
		expect(detail.truncated).toBeUndefined();
	}, 30_000);

	/**
	 * `tool.detail` and `tools.list` answers skip the Host's emit-time redaction, so the projection
	 * is the only guard. Each value puts the Host-learned key ten characters before its section's
	 * cut: cutting first would leave the key's opening characters, which no later pass can match.
	 */
	const KEY = "QXJ9-kv7w-ZP2M-4tN8-Hc6R-credential";
	const straddle = (fill: string, cut: number, offset = 0) => `${fill.repeat(cut - 10 - offset)}${KEY}`;
	const expectNoKey = (value: unknown) => {
		const text = JSON.stringify(value);
		expect(text).not.toContain(KEY.slice(0, 6));
		expect(text).not.toContain(KEY.slice(-10));
	};

	test("every tool.detail section is redacted by the Host's own credentials before its cut", async () => {
		const h = await fixture();
		await h.respond("auth.setKey", { provider: "unknown-provider", key: KEY });
		const limits = DESKTOP_TOOL_LIMITS;
		const call = (id: string, name: string, args: Record<string, unknown>) => ({
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id, name, arguments: args }],
		});
		const result = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1,
			...extra,
		});
		// The envelope names both files; the result names neither, so the headers do.
		const envelope = `*** Begin Patch\n*** Update File: ${straddle("p", limits.subject)}\n*** Update File: b-${KEY}.ts\n*** End Patch`;
		const args = JSON.stringify({ cwd: "" }, null, 2);
		h.sdk.agent.replaceMessages([
			call("toolu_edit", "edit", { input: envelope }),
			result("toolu_edit", "edit", {
				details: {
					perFileResults: [
						// The first file's diff fills the whole diff bound and crosses it.
						{ diff: straddle("d", limits.diff), op: "update" },
						{ diff: "", isError: true, displayErrorText: straddle("e", limits.description) },
						// A path the result states wins over the envelope's.
						{ path: straddle("r", limits.subject), diff: "+1|x" },
					],
				},
			}),
			call("toolu_write", "write", { file_path: `notes/${KEY}.md`, content: `top\n${KEY}\nend\n` }),
			result("toolu_write", "write"),
			call("toolu_bash", "bash", {
				command: straddle("c", limits.args),
				cwd: straddle("w", limits.args, args.indexOf('""') + 1),
			}),
			result("toolu_bash", "bash"),
			call("toolu_search", "search_tool_bm25", { query: straddle("q", limits.subject) }),
			result("toolu_search", "search_tool_bm25", {
				details: {
					query: straddle("q", limits.subject),
					activated_tools: [KEY],
					tools: [
						{
							name: `t-${KEY}`,
							label: straddle("l", 100),
							description: straddle("s", limits.description),
							server_name: straddle("m", 100),
						},
					],
				},
			}),
		] as never);
		const detail = (callId: string) => h.call<DesktopToolDetail>("tool.detail", { sessionId: h.session.id, callId });

		const edit = await detail("toolu_edit");
		expect(edit.diff?.map(file => file.path)).toEqual([
			`${"p".repeat(limits.subject - 10)}[redacted]`,
			"b-[redacted].ts",
			`${"r".repeat(limits.subject - 10)}[redacted]`,
		]);
		expect(edit.diff?.[0]?.diff).toBe(`${"d".repeat(limits.diff - 10)}[redacted]`);
		expect(edit.diff?.[1]?.error).toBe(`${"e".repeat(limits.description - 10)}[redacted]`);
		expectNoKey(edit);

		const write = await detail("toolu_write");
		expect(write.diff).toEqual([
			{ path: "notes/[redacted].md", diff: "+1|top\n+2|[redacted]\n+3|end", added: 3, removed: 0 },
		]);
		expectNoKey(write);

		const bash = await detail("toolu_bash");
		expect(bash.command).toBe(`${"c".repeat(limits.args - 10)}[redacted]`);
		expect(bash.args?.endsWith("[redacted]")).toBe(true);
		expect(bash.args).toHaveLength(limits.args);
		expectNoKey(bash);

		const search = (await detail("toolu_search")).toolSearch;
		expect(search).toMatchObject({
			query: `${"q".repeat(limits.subject - 10)}[redacted]`,
			activated: ["[redacted]"],
			matches: [
				{
					name: "t-[redacted]",
					label: `${"l".repeat(90)}[redacted]`,
					description: `${"s".repeat(limits.description - 10)}[redacted]`,
					mcpServer: `${"m".repeat(90)}[redacted]`,
				},
			],
		});
		expectNoKey(search);
	}, 30_000);

	test("every tools.list string is redacted by the Host's own credentials before its cut", async () => {
		const h = await fixture();
		await h.respond("auth.setKey", { provider: "unknown-provider", key: KEY });
		const [name] = h.sdk.getAllToolNames();
		const lookup = h.sdk.getToolByName.bind(h.sdk);
		const tool = lookup(name!)!;
		// A catalog bound ends in an ellipsis, so the visible text stops one character early; each
		// value runs on past the bound so that the bound applies.
		const cut = DESKTOP_TOOL_LIMITS.description - 1;
		const long = (fill: string) => `${straddle(fill, cut)} and more`;
		spies.push(
			vi.spyOn(h.sdk, "getToolByName").mockImplementation(other =>
				other === name
					? Object.create(tool, {
							label: { value: long("l") },
							summary: { value: long("s") },
							mcpServerName: { value: long("m") },
						})
					: lookup(other),
			),
		);
		const list = await h.call<DesktopToolList>("tools.list", { sessionId: h.session.id });
		const entry = list.tools?.find(item => item.name === name);
		expect(entry).toMatchObject({
			label: `${"l".repeat(cut - 10)}[redacted]…`,
			description: `${"s".repeat(cut - 10)}[redacted]…`,
			mcpServer: `${"m".repeat(cut - 10)}[redacted]…`,
		});
		expectNoKey(list);
	}, 30_000);
});
