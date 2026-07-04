import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import {
	GJC_COORDINATOR_SESSION_BRANCH_ENV,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
	persistCoordinatorRuntimeStateFromPostmortem,
	readTerminalRuntimeStateMarker,
} from "../src/gjc-runtime/session-state-sidecar";

const tempDirs: string[] = [];
const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const ORIGINAL_SESSION_ID = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
const ORIGINAL_BRANCH = process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sidecar-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	if (ORIGINAL_SESSION_ID === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = ORIGINAL_SESSION_ID;
	if (ORIGINAL_BRANCH === undefined) delete process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV];
	else process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV] = ORIGINAL_BRANCH;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("coordinator runtime state sidecar", () => {
	it("persists final assistant text on agent_end", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "visible-session";

		await persistCoordinatorRuntimeStateFromEvent(
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Done from runtime" }],
						stopReason: "stop",
					},
				],
			},
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			session_id: "visible-session",
			state: "completed",
			final_response: {
				text: "Done from runtime",
				format: "markdown",
				source: "agent_end",
				artifact_path: null,
				truncated: false,
			},
		});
	});

	it("recognizes only matching completed or errored runtime markers as terminal", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "session-a",
				state: "completed",
				cwd: root,
				session_file: path.join(root, "session.jsonl"),
			}),
		);

		await expect(
			readTerminalRuntimeStateMarker({
				stateFile,
				sessionId: "session-a",
				cwd: root,
				sessionFile: path.join(root, "session.jsonl"),
			}),
		).resolves.toEqual({ terminal: true, state: "completed" });
		await expect(readTerminalRuntimeStateMarker({ stateFile, sessionId: "other", cwd: root })).resolves.toEqual({
			terminal: false,
			reason: "session_id_mismatch",
		});
	});

	it("rejects non-terminal and mismatched runtime markers", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "session-a",
				state: "running",
				cwd: root,
				session_file: path.join(root, "session.jsonl"),
			}),
		);

		await expect(readTerminalRuntimeStateMarker({ stateFile, sessionId: "session-a", cwd: root })).resolves.toEqual({
			terminal: false,
			reason: "non_terminal_state",
		});
		await expect(
			readTerminalRuntimeStateMarker({ stateFile, sessionId: "session-a", cwd: path.join(root, "other") }),
		).resolves.toEqual({ terminal: false, reason: "cwd_mismatch" });
	});

	it("writes public-safe postmortem exit evidence without transcript payloads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "postmortem-session";
		process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV] = "issue-1496";

		persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: path.join(root, "session.jsonl"),
		});

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			schema_version: 1,
			session_id: "postmortem-session",
			state: "errored",
			ready_for_input: false,
			source: "process_postmortem",
			event: "process_exit",
			reason: "sigterm",
			exit_kind: "sigterm",
			signal: "SIGTERM",
			cwd: root,
			workdir: root,
			branch: "issue-1496",
			session_file: path.join(root, "session.jsonl"),
			error: { code: "sigterm", recoverable: true },
		});
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("transcript");
		expect(payload).not.toHaveProperty("paneLog");
	});

	it("does not overwrite richer terminal agent_end evidence during postmortem", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "preserved-session";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "preserved-session",
				state: "completed",
				final_response: { source: "agent_end", text: "Already done" },
			}),
		);

		persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			state: "completed",
			final_response: { source: "agent_end", text: "Already done" },
		});
		expect(payload.source).not.toBe("process_postmortem");
	});
});
