import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSdkSessionCli } from "../src/sdk/cli/session-cli";
import type { ExternalPermissionRequest } from "../src/sdk/host/external-permissions";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

test("public session CLI enables, queries and answers native-host tool approvals", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-public-approval-"));
	const host = await startProductionSdkHost(cwd, { acceptPromptPreflightWithoutExecution: true });
	const agentDir = path.join(cwd, ".gjc", "agent");
	const raw = async (kind: "control" | "query", operation: string, input: unknown = {}): Promise<unknown> => {
		let output: unknown;
		await runSdkSessionCli(
			{
				action: "raw",
				rawAction: kind,
				sessionId: host.sessionId,
				agentDir,
				...(kind === "control" ? { operation } : { query: operation }),
				jsonInput: JSON.stringify(input),
				json: true,
			},
			value => {
				output = value;
			},
		);
		return output;
	};
	try {
		expect(await raw("control", "permission.channel.set", { enabled: true })).toMatchObject({
			ok: true,
			result: { enabled: true },
		});
		expect(host.session.sdkPermissionMode).toBe("prompt");
		const tool = host.session.agent.state.tools.find(candidate => candidate.name === "bash")!;
		expect(tool).toBeDefined();
		const execution = tool
			.execute(
				"external-call",
				{ command: "printf should-not-run" },
				undefined,
				undefined as never,
				undefined as never,
			)
			.catch(error => error as Error);
		let requests: ExternalPermissionRequest[] = [];
		for (let attempt = 0; attempt < 20 && requests.length === 0; attempt++) {
			const snapshot = (await raw("query", "permission.requests.list")) as {
				result: { requests: ExternalPermissionRequest[] };
			};
			requests = snapshot.result.requests;
		}
		expect(requests).toHaveLength(1);
		expect(requests[0]!.toolCall.rawInput).toMatchObject({ command: "printf should-not-run" });
		await expect(raw("query", "permission.requests.list", [])).rejects.toThrow("Public command failed");
		await expect(
			raw("control", "permission.respond", {
				sessionId: "another-session",
				id: requests[0]!.id,
				optionId: "allow_once",
			}),
		).rejects.toThrow("Public command failed");
		expect(
			await raw("control", "permission.respond", {
				sessionId: host.sessionId,
				id: requests[0]!.id,
				optionId: "reject_once",
				comment: "Do not execute this command",
			}),
		).toMatchObject({ ok: true, result: { accepted: true } });
		expect(((await execution) as Error).message).toContain("Do not execute this command");
		await expect(
			raw("control", "permission.respond", {
				sessionId: host.sessionId,
				id: requests[0]!.id,
				optionId: "allow_once",
			}),
		).rejects.toThrow("Public command failed");
		expect(await raw("query", "permission.requests.list")).toMatchObject({ ok: true, result: { requests: [] } });
		const approved = tool.execute(
			"approved-call",
			{ command: "printf sdk-approved" },
			undefined,
			undefined as never,
			undefined as never,
		);
		void approved.catch(() => {});
		let approvalId: string | undefined;
		for (let attempt = 0; attempt < 20 && !approvalId; attempt++) {
			const snapshot = (await raw("query", "permission.requests.list")) as {
				result: { requests: ExternalPermissionRequest[] };
			};
			approvalId = snapshot.result.requests[0]?.id;
		}
		expect(approvalId).toBeDefined();
		await expect(raw("control", "permission_mode.set", { mode: "invalid" })).rejects.toThrow("Public command failed");
		expect(await raw("control", "permission_mode.set", { mode: "prompt" })).toMatchObject({
			ok: true,
			result: { changed: false, mode: "prompt" },
		});
		expect(await raw("query", "permission.requests.list")).toMatchObject({
			result: { requests: [{ id: approvalId }] },
		});
		expect(
			await raw("control", "permission.respond", {
				sessionId: host.sessionId,
				id: approvalId,
				optionId: "allow_once",
			}),
		).toMatchObject({ ok: true, result: { accepted: true } });
		expect(JSON.stringify(await approved)).toContain("sdk-approved");
		const cancelled = tool
			.execute(
				"mode-change-call",
				{ command: "printf should-not-run" },
				undefined,
				undefined as never,
				undefined as never,
			)
			.catch(error => error as Error);
		let cancelledId: string | undefined;
		for (let attempt = 0; attempt < 20 && !cancelledId; attempt++) {
			const snapshot = (await raw("query", "permission.requests.list")) as {
				result: { requests: ExternalPermissionRequest[] };
			};
			cancelledId = snapshot.result.requests[0]?.id;
		}
		expect(cancelledId).toBeDefined();
		expect(await raw("control", "permission_mode.set", { mode: "always-deny" })).toMatchObject({
			ok: true,
			result: { changed: true, mode: "deny" },
		});
		expect(((await cancelled) as Error).message).toBe("Permission request cancelled");
		expect(await raw("query", "permission.requests.list")).toMatchObject({ result: { requests: [] } });
		await expect(
			raw("control", "permission.respond", {
				sessionId: host.sessionId,
				id: cancelledId,
				optionId: "allow_once",
			}),
		).rejects.toThrow("Public command failed");
		await raw("control", "permission_mode.set", { mode: "prompt" });
		expect(await raw("control", "permission.channel.set", { enabled: false })).toMatchObject({
			ok: true,
			result: { enabled: false },
		});
		expect(host.session.sdkPermissionMode).toBe("prompt");
		await expect(
			tool.execute(
				"disabled-call",
				{ command: "printf should-not-run" },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow("no permission provider is connected");
	} finally {
		await host.stop();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
