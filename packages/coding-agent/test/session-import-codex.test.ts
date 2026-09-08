import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	CODEX_IMPORT_BATCH_LIMIT,
	closeCodexSessionAuthorities,
	convertCodexSession,
	discoverCodexSessions,
	sanitizeImportedString,
	sanitizeImportedValue,
} from "../src/session-import/codex";
import { importCodexSessions } from "../src/session-import/service";
import { executeLocalHeadlessBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const originalAgentDir = getAgentDir();
const roots: string[] = [];
let root = "";
let workspace = "";
let codexHome = "";
const stamp = "2026-01-02T03:04:05.000Z";
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const meta = (id: string, cwd: string) =>
	line({
		timestamp: stamp,
		type: "session_meta",
		payload: { id, cwd, timestamp: stamp, cli_version: "codex-test", model_provider: "openai" },
	});
const message = (role: "user" | "assistant", text: string) =>
	line({
		timestamp: stamp,
		type: "response_item",
		payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
	});

async function source(id: string, cwd: string, events: string[]): Promise<void> {
	const dir = path.join(codexHome, "sessions", "2026");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(dir, `${id}.jsonl`), `${meta(id, cwd)}${events.join("")}`, { mode: 0o600 });
	await fs.appendFile(
		path.join(codexHome, "session_index.jsonl"),
		line({ id, thread_name: `Codex ${id}`, updated_at: stamp }),
		{ mode: 0o600 },
	);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-import-"));
	roots.push(root);
	workspace = path.join(root, "workspace");
	codexHome = path.join(root, "codex");
	await fs.mkdir(workspace, { recursive: true });
	await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
	await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
	setAgentDir(path.join(root, "agent"));
	process.env.CODEX_HOME = codexHome;
});

afterEach(async () => {
	delete process.env.CODEX_HOME;
	setAgentDir(originalAgentDir);
	for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true });
});

describe("Codex import sanitization", () => {
	it("sanitizes secrets and hostile controls", () => {
		const text = sanitizeImportedString(
			"Bearer abcdefghijklmnop sk-proj-abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart https://u:p@example.test/ password=hunter2 AKIA1234567890ABCDEF -----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY----- \u001b[31m<​|end|>\u202e",
		);
		expect(text.value).not.toContain("abcdefghijklmnop");
		expect(text.value).not.toContain("u:p");
		expect(text.value).not.toContain("hunter2");
		expect(text.value).not.toContain("AKIA1234567890ABCDEF");
		expect(text.value).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(text.value).not.toContain("\nprivate\n");
		expect(text.value).not.toContain("-----BEGIN PRIVATE KEY-----");
		expect(text.value).not.toContain("\u001b");
		expect(text.value).not.toContain("<​|end|>");
		expect(text.value).not.toContain("\u202e");
		expect(
			sanitizeImportedValue({ authorization: "secret", nested: { api_key: "secret", safe: "ok" } }).value,
		).toEqual({ authorization: "[redacted-field]", nested: { api_key: "[redacted-field]", safe: "ok" } });
	});

	it("redacts header-style credentials while preserving header context", () => {
		const input = [
			"Authorization: Basic dXNlcjpwYXNz",
			"Authorization: Bearer x",
			"Authorization: Digest opaque-secret",
			"Authorization: opaque-secret",
			'{"Authorization":"Bearer json-secret"}',
			"Cookie: session=session-cookie-secret; theme=dark",
			"Set-Cookie: sid=set-cookie-secret; Path=/; HttpOnly",
			"X-Request-Id: request-id-kept",
			"ordinary text remains usable",
		].join("\n");
		const sanitized = sanitizeImportedString(input);
		expect(sanitized.value).not.toContain("dXNlcjpwYXNz");
		expect(sanitized.value).not.toContain("session-cookie-secret");
		expect(sanitized.value).not.toContain("set-cookie-secret");
		expect(sanitized.value).not.toContain("x\n");
		expect(sanitized.value).not.toContain("opaque-secret");
		expect(sanitized.value).not.toContain("json-secret");
		expect(sanitized.value).toContain("Authorization: Basic [redacted-credentials]");
		expect(sanitized.value).toContain("Authorization: Bearer [redacted-credentials]");
		expect(sanitized.value).toContain("Authorization: Digest [redacted-credentials]");
		expect(sanitized.value).toContain("Authorization: [redacted-credentials]");
		expect(sanitized.value).toContain('{"Authorization":"Bearer [redacted-credentials]"}');
		expect(sanitized.value).toContain("Cookie: session=[redacted-credentials]; theme=[redacted-credentials]");
		expect(sanitized.value).toContain("Set-Cookie: sid=[redacted-credentials]; Path=/; HttpOnly");
		expect(sanitized.value).toContain("X-Request-Id: request-id-kept");
		expect(sanitized.value).toContain("ordinary text remains usable");
		expect(sanitized.redacted).toBe(8);
	});

	it("keeps header labels and ordinary text when no credential value is present", () => {
		const input = "Authorization: Basic\nCookie: notes\nSet-Cookie: example\nHeader: keep-this";
		expect(sanitizeImportedString(input)).toEqual({ value: input, redacted: 0 });
	});
});

describe.skipIf(process.platform !== "linux")("Codex session import", () => {
	it("returns a failing local-headless status when import discovery fails", async () => {
		const output: string[] = [];
		const result = await executeLocalHeadlessBuiltinSlashCommand("/import-session missing-id --provider codex", {
			cwd: workspace,
			output: (text: string) => output.push(text),
		} as unknown as SlashCommandRuntime);
		expect(result).toEqual({ consumed: true, exitCode: 1 });
		expect(output.join("\n")).toContain("source_not_found");
	});

	it("uses the latest sanitized Codex session index title", async () => {
		await source("named-session", workspace, [message("user", "hello")]);
		await fs.appendFile(
			path.join(codexHome, "session_index.jsonl"),
			line({ id: "named-session", thread_name: "실제 Codex 세션 이름\u001b[31m", updated_at: stamp }),
		);
		const discovered = await discoverCodexSessions(workspace, ["named-session"], codexHome, true);
		try {
			expect(discovered[0]?.title).toBe("실제 Codex 세션 이름[control-sequence]");
		} finally {
			await closeCodexSessionAuthorities(discovered);
		}
		const batch = await importCodexSessions(workspace, ["named-session"]);
		const result = batch.results[0];
		if (!result || result.status === "failed") throw new Error("Expected named import success");
		const [header] = (await fs.readFile(result.targetPath, "utf8")).split("\n");
		expect(JSON.parse(header!).title).toBe("실제 Codex 세션 이름[control-sequence]");
	});

	it("infers a sanitized title when the Codex index has no entry", async () => {
		await source("unindexed-session", workspace, [
			message("user", "# AGENTS.md instructions for a workspace"),
			message("user", "세션 가져오기 오류 해결\n상세 내용"),
		]);
		await fs.writeFile(path.join(codexHome, "session_index.jsonl"), "");
		const batch = await importCodexSessions(workspace, ["unindexed-session"]);
		const result = batch.results[0];
		if (!result || result.status === "failed") throw new Error("Expected inferred-title import success");
		const [header] = (await fs.readFile(result.targetPath, "utf8")).split("\n");
		expect(JSON.parse(header!).title).toBe("세션 가져오기 오류 해결");
	});
	it("discovers exact-workspace sessions and explicit IDs", async () => {
		await source("same-a", workspace, [message("user", "one")]);
		await source("same-b", workspace, [message("assistant", "two")]);
		await source("other", path.join(root, "other"), [message("user", "hidden")]);
		expect((await discoverCodexSessions(workspace, [], codexHome)).map(value => value.id)).toEqual([
			"same-a",
			"same-b",
		]);
		expect((await discoverCodexSessions(workspace, ["same-b"], codexHome)).map(value => value.id)).toEqual([
			"same-b",
		]);
		await expect(discoverCodexSessions(workspace, ["other"], codexHome)).rejects.toMatchObject({
			code: "source_not_found",
		});
		const alias = path.join(root, "workspace-alias");
		await fs.symlink(workspace, alias);
		expect((await discoverCodexSessions(alias, ["same-a"], codexHome)).map(value => value.id)).toEqual(["same-a"]);

		const importedAll = await importCodexSessions(workspace, []);
		expect(importedAll.status).toBe("success");
		expect(
			importedAll.results.filter(result => result.status !== "failed").map(result => result.sourceSessionId),
		).toEqual(["same-a", "same-b"]);
		expect((await importCodexSessions(alias, ["same-a"])).status).toBe("existing");
		await fs.writeFile(
			path.join(codexHome, "sessions", "2026", "duplicate.jsonl"),
			`${meta("same-a", workspace)}${message("user", "duplicate")}`,
		);
		await expect(discoverCodexSessions(workspace, [], codexHome)).rejects.toMatchObject({
			code: "malformed_source",
		});
	});
	it("rejects automatic imports above the explicit session batch limit", async () => {
		for (let index = 0; index <= CODEX_IMPORT_BATCH_LIMIT; index++) {
			const id = `batch-limit-${index.toString().padStart(3, "0")}`;
			await source(id, workspace, [message("assistant", "bounded")]);
		}

		expect(await importCodexSessions(workspace, [])).toMatchObject({
			status: "failed",
			results: [
				{
					status: "failed",
					code: "content_too_large",
					phase: "discovery",
					retryable: false,
				},
			],
		});
	});

	it("rejects symlinked Codex sources and accepts hard-linked sources", async () => {
		await source("safe-source", workspace, [message("user", "safe")]);
		await source("hard-linked", workspace, [message("user", "hard-linked")]);
		const directory = path.join(codexHome, "sessions", "2026");
		await fs.symlink(path.join(directory, "safe-source.jsonl"), path.join(directory, "symlink-source.jsonl"));

		expect((await discoverCodexSessions(workspace, ["safe-source"], codexHome)).map(value => value.id)).toEqual([
			"safe-source",
		]);
		await expect(discoverCodexSessions(workspace, ["symlink-source"], codexHome)).rejects.toMatchObject({
			code: "source_not_found",
		});
		// Hard-linked files (nlink > 1) are accepted — real Codex rollout files
		// legitimately have nlink = 2.
		expect((await discoverCodexSessions(workspace, ["hard-linked"], codexHome)).map(value => value.id)).toEqual([
			"hard-linked",
		]);
	});
	it("rejects group-writable retained Codex roots during discovery", async () => {
		await source("untrusted-root", workspace, [message("user", "unsafe root")]);
		await fs.chmod(path.join(codexHome, "sessions"), 0o775);
		await expect(discoverCodexSessions(workspace, ["untrusted-root"], codexHome, true)).rejects.toMatchObject({
			code: "source_untrusted",
			phase: "discovery",
		});
	});
	it("rejects retained conversion after its root becomes group-writable", async () => {
		await source("conversion-untrusted-root", workspace, [message("user", "unsafe conversion root")]);
		const sources = await discoverCodexSessions(workspace, ["conversion-untrusted-root"], codexHome, true);
		try {
			await fs.chmod(path.join(codexHome, "sessions"), 0o775);
			await expect(convertCodexSession(sources[0]!)).rejects.toMatchObject({
				code: "source_untrusted",
				phase: "discovery",
			});
		} finally {
			await fs.chmod(path.join(codexHome, "sessions"), 0o700);
			await closeCodexSessionAuthorities(sources);
		}
	});
	it("rejects workspace replacement after retained discovery", async () => {
		await source("workspace-swap", workspace, [message("user", "trusted")]);
		const sources = await discoverCodexSessions(workspace, ["workspace-swap"], codexHome, true);
		const movedWorkspace = path.join(root, "moved-workspace");
		await fs.rename(workspace, movedWorkspace);
		await fs.mkdir(workspace);
		try {
			await expect(convertCodexSession(sources[0]!)).rejects.toMatchObject({
				code: "source_untrusted",
				phase: "discovery",
			});
		} finally {
			await closeCodexSessionAuthorities(sources);
		}
	});

	it("classifies malformed first metadata consistently during discovery", async () => {
		const directory = path.join(codexHome, "sessions", "2026");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, "malformed-metadata.jsonl"), "{not-json}\n", { mode: 0o600 });
		for (const retainSourceAuthority of [false, true]) {
			await expect(discoverCodexSessions(workspace, [], codexHome, retainSourceAuthority)).rejects.toMatchObject({
				code: "malformed_source",
				phase: "discovery",
			});
		}
	});
	it("classifies invalid candidate metadata consistently in retained and pathname discovery", async () => {
		const directory = path.join(codexHome, "sessions", "2026");
		await fs.mkdir(directory, { recursive: true });
		const candidates: Array<{ name: string; record: unknown }> = [
			{ name: "null", record: null },
			{ name: "array", record: [] },
			{ name: "payload-null", record: { type: "session_meta", payload: null } },
			{ name: "payload-array", record: { type: "session_meta", payload: [] } },
			{ name: "payload-string", record: { type: "session_meta", payload: "invalid" } },
			{ name: "missing-fields", record: { type: "session_meta", payload: {} } },
			{ name: "invalid-id", record: { type: "session_meta", payload: { id: "bad/id", cwd: workspace } } },
			{ name: "wrong-id-type", record: { type: "session_meta", payload: { id: 42, cwd: workspace } } },
			{ name: "missing-cwd", record: { type: "session_meta", payload: { id: "valid-id" } } },
			{ name: "wrong-cwd-type", record: { type: "session_meta", payload: { id: "valid-id", cwd: 42 } } },
			{ name: "empty-cwd", record: { type: "session_meta", payload: { id: "valid-id", cwd: "" } } },
		];
		for (const candidate of candidates) {
			const file = path.join(directory, `invalid-${candidate.name}.jsonl`);
			await fs.writeFile(file, line(candidate.record), { mode: 0o600 });
			try {
				for (const retainSourceAuthority of [false, true]) {
					await expect(
						discoverCodexSessions(workspace, [], codexHome, retainSourceAuthority),
					).rejects.toMatchObject({ code: "malformed_source", phase: "discovery" });
				}
			} finally {
				await fs.rm(file, { force: true });
			}
		}
	});
	it("skips unrelated JSONL records during discovery", async () => {
		const directory = path.join(codexHome, "sessions", "2026");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, "unrelated.jsonl"),
			line({ type: "event_msg", payload: { message: "not session metadata" } }),
			{ mode: 0o600 },
		);
		for (const retainSourceAuthority of [false, true]) {
			expect(await discoverCodexSessions(workspace, [], codexHome, retainSourceAuthority)).toEqual([]);
		}
	});
	it("classifies non-object JSONL records as malformed source", async () => {
		await source("null-record", workspace, ["null\n"]);
		const batch = await importCodexSessions(workspace, ["null-record"]);
		expect(batch).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "malformed_source", phase: "source_event" }],
		});
	});

	it("bounds an unterminated oversized JSONL record before parsing", async () => {
		await source("oversized-line", workspace, ["z".repeat(8 * 1024 * 1024 + 1)]);
		expect(await importCodexSessions(workspace, ["oversized-line"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "content_too_large", phase: "source_line" }],
		});
	});

	it("rejects oversized converted output before completing a large staged transcript", async () => {
		const id = "oversized-converted-output";
		const targetTranscriptMaxBytes = 128 * 1024 * 1024;
		const durablePrefixReserveBytes = 1024 * 1024;
		const convertedText = "x".repeat(512 * 1024);
		const events = Array.from({ length: 260 }, () => message("assistant", convertedText));
		expect(Buffer.byteLength(`${meta(id, workspace)}${events.join("")}`, "utf8")).toBeGreaterThan(
			targetTranscriptMaxBytes,
		);
		await source(id, workspace, events);

		let stagedBodyBytes = 0;
		const realOpen = fs.open.bind(fs);
		const openSpy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
			if (path.basename(String(file)) !== "body.jsonl") return handle;
			const write = handle.write.bind(handle) as (...args: unknown[]) => Promise<unknown>;
			(handle as unknown as { write: (...args: unknown[]) => Promise<unknown> }).write = async (...args) => {
				const bytes = args[0];
				if (bytes instanceof Uint8Array) stagedBodyBytes += bytes.byteLength;
				return write(...args);
			};
			return handle;
		}) as typeof fs.open);
		try {
			expect(await importCodexSessions(workspace, [id])).toMatchObject({
				status: "failed",
				results: [
					{
						status: "failed",
						code: "content_too_large",
						phase: "source_event",
						limitBytes: targetTranscriptMaxBytes,
					},
				],
			});
			expect(stagedBodyBytes).toBeGreaterThan(0);
			expect(stagedBodyBytes).toBeLessThanOrEqual(targetTranscriptMaxBytes - durablePrefixReserveBytes);
		} finally {
			openSpy.mockRestore();
		}
	}, 300_000);

	it("imports, quarantines, resumes, continues, and deduplicates", async () => {
		await source("fixture", workspace, [
			message("user", "hello sk_abcdefghijklmnop"),
			message("assistant", "world <​|end|>"),
			line({
				timestamp: stamp,
				type: "response_item",
				payload: { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"safe"}' },
			}),
			line({
				timestamp: stamp,
				type: "response_item",
				payload: { type: "function_call_output", call_id: "call-1", output: "done" },
			}),
			line({
				timestamp: stamp,
				type: "response_item",
				payload: { type: "reasoning", token: "Bearer abcdefghijklmnop" },
			}),
			line({
				timestamp: stamp,
				type: "response_item",
				payload: { type: "unknown-Bearer abcdefghijklmnop\u001b[31m", value: "safe" },
			}),
		]);
		const batch = await importCodexSessions(workspace, ["fixture"]);
		if (batch.status !== "success") throw new Error(JSON.stringify(batch));
		expect(batch.status).toBe("success");
		const result = batch.results[0];
		if (!result || result.status === "failed") throw new Error("Expected import success");
		expect(result).toMatchObject({ status: "imported", mappedEvents: 4, quarantinedEvents: 2 });
		const transcript = await fs.readFile(result.targetPath, "utf8");
		expect(transcript).toContain('"version":5');
		expect(transcript).toContain('"type":"toolCall"');
		expect(transcript).toContain('"role":"toolResult"');
		expect(transcript).not.toContain("abcdefghijklmnop");
		expect(transcript).toContain('"providerId":"openai-codex"');
		expect(transcript).toContain('"sourceSessionId":"fixture"');
		expect(transcript).toContain('"cliVersion":"codex-test"');
		expect(transcript).toContain('"modelProvider":"openai"');
		expect(transcript).toMatch(/"workspaceSha256":"[a-f0-9]{64}"/u);
		const quarantine = await fs.readFile(path.join(result.targetPath.slice(0, -6), "codex-quarantine.jsonl"), "utf8");
		expect(quarantine).not.toContain("abcdefghijklmnop");
		expect(quarantine).not.toContain("\u001b");
		const inspection = await SessionManager.inspectSessionTailReadOnly(result.targetPath);
		if (inspection.kind === "error") throw new Error(inspection.reason);
		const opened = await SessionManager.openExistingStrict(inspection.identity, path.dirname(result.targetPath));
		if (opened.kind === "error") throw new Error(opened.reason);
		opened.manager.appendModelChange("openai-codex/codex-imported-history", "temporary");
		opened.manager.appendCustomEntry("import-regression-continuation", { safe: true });
		opened.manager.appendMessage({ role: "user", content: "continued", timestamp: 1 });
		await opened.manager.close();
		const restarted = await SessionManager.inspectSessionTailReadOnly(result.targetPath);
		if (restarted.kind === "error") throw new Error(restarted.reason);
		const reopened = await SessionManager.openExistingStrict(restarted.identity, path.dirname(result.targetPath));
		if (reopened.kind === "error") throw new Error(reopened.reason);
		expect(reopened.manager.buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: "continued",
		});
		await reopened.manager.close();
		expect((await importCodexSessions(workspace, ["fixture"])).status).toBe("existing");
	});
	it("rejects a missing or changed quarantine attachment on retry", async () => {
		await source("quarantine-tamper", workspace, [
			line({
				timestamp: stamp,
				type: "response_item",
				payload: { type: "reasoning", value: "bounded" },
			}),
		]);
		const imported = await importCodexSessions(workspace, ["quarantine-tamper"]);
		const result = imported.results[0];
		if (!result || result.status === "failed") throw new Error("Expected import success");
		const quarantinePath = path.join(result.targetPath.slice(0, -6), "codex-quarantine.jsonl");
		await fs.writeFile(quarantinePath, '{"tampered":true}\n');
		expect(await importCodexSessions(workspace, ["quarantine-tamper"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "destination_conflict" }],
		});
	});

	it("rejects changed imported history instead of treating it as continuation", async () => {
		await source("tamper-source", workspace, [message("assistant", "original")]);
		const imported = await importCodexSessions(workspace, ["tamper-source"]);
		const result = imported.results[0];
		if (!result || result.status === "failed") throw new Error("Expected import success");
		const before = await fs.readFile(result.targetPath, "utf8");
		const after = before.replace('"text":"original"', '"text":"tampered"');
		expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
		await fs.writeFile(result.targetPath, after);

		expect(await importCodexSessions(workspace, ["tamper-source"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "destination_conflict" }],
		});
	});

	it("reconciles a manifest-bound orphan before retrying publication", async () => {
		await source("orphan-source", workspace, [message("assistant", "recover")]);
		const first = await importCodexSessions(workspace, ["orphan-source"]);
		const result = first.results[0];
		if (!result || result.status === "failed") throw new Error("Expected import success");
		await fs.rm(result.targetPath);

		const retry = await importCodexSessions(workspace, ["orphan-source"]);
		if (retry.status !== "success") throw new Error(JSON.stringify(retry));
		expect(retry.results[0]).toMatchObject({
			status: "imported",
			targetSessionId: result.targetSessionId,
		});
	});
	it("fails closed when managed candidate listing is incomplete", async () => {
		await source("listing-baseline", workspace, [message("assistant", "baseline")]);
		const first = await importCodexSessions(workspace, ["listing-baseline"]);
		const baseline = first.results[0];
		if (!baseline || baseline.status === "failed") throw new Error("Expected baseline import success");
		await fs.writeFile(path.join(path.dirname(baseline.targetPath), "unreadable.jsonl"), "{not-json}\n", {
			mode: 0o600,
		});
		await source("listing-uncertain", workspace, [message("assistant", "uncertain")]);

		expect(await importCodexSessions(workspace, ["listing-uncertain"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "binding_invalid", phase: "internal" }],
		});
	});
	it("distinguishes an absent staging root from a staging-root read error", async () => {
		await source("staging-root-setup", workspace, [message("assistant", "setup")]);
		const first = await importCodexSessions(workspace, ["staging-root-setup"]);
		const setup = first.results[0];
		if (!setup || setup.status === "failed") throw new Error("Expected staging setup import success");
		const stagingRoot = path.join(path.dirname(setup.targetPath), ".gjc-managed-session-internal", "import-staging");

		await fs.rm(stagingRoot, { recursive: true });
		await source("missing-staging-root", workspace, [message("assistant", "missing root is first-run safe")]);
		expect(await importCodexSessions(workspace, ["missing-staging-root"])).toMatchObject({
			status: "success",
			results: [{ status: "imported", sourceSessionId: "missing-staging-root" }],
		});

		await fs.rm(stagingRoot, { recursive: true });
		await fs.writeFile(stagingRoot, "not a directory", { mode: 0o600 });
		await source("blocked-staging-root", workspace, [message("assistant", "blocked")]);
		expect(await importCodexSessions(workspace, ["blocked-staging-root"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "internal_failed", phase: "internal" }],
		});
		expect((await fs.lstat(stagingRoot)).isFile()).toBe(true);
	});
	it("preserves staging when a recovery receipt is not a regular file", async () => {
		await source("receipt-path-setup", workspace, [message("assistant", "receipt setup")]);
		const first = await importCodexSessions(workspace, ["receipt-path-setup"]);
		const setup = first.results[0];
		if (!setup || setup.status === "failed") throw new Error("Expected receipt setup import success");
		await fs.rm(setup.targetPath);
		const recoveryDirectory = path.join(
			path.dirname(setup.targetPath),
			".gjc-managed-session-internal",
			"import-staging",
			"receipt-path-uncertain",
		);
		const receiptPath = path.join(recoveryDirectory, "artifact-recovery.json");
		await fs.mkdir(receiptPath, { recursive: true });
		const managedDirectory = path.dirname(setup.targetPath);
		const before = (await fs.readdir(managedDirectory)).sort();

		await source("receipt-path-blocked", workspace, [message("assistant", "receipt blocked")]);
		expect(await importCodexSessions(workspace, ["receipt-path-blocked"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "publish_uncertain", phase: "internal", retryable: true }],
		});
		expect((await fs.lstat(receiptPath)).isDirectory()).toBe(true);
		expect((await fs.readdir(managedDirectory)).sort()).toEqual(before);
	});
	it("preserves staging when a bound transcript path is not a regular file", async () => {
		await source("transcript-path-setup", workspace, [message("assistant", "transcript setup")]);
		const first = await importCodexSessions(workspace, ["transcript-path-setup"]);
		const setup = first.results[0];
		if (!setup || setup.status === "failed") throw new Error("Expected transcript setup import success");
		const artifactDirectory = setup.targetPath.slice(0, -6);
		const manifest = JSON.parse(
			await fs.readFile(path.join(artifactDirectory, "codex-import-manifest.json"), "utf8"),
		) as {
			provenance: Record<string, unknown> & {
				providerId: string;
				sourceSessionId: string;
				sourceSha256: string;
				converterVersion: number;
				sanitizerVersion: number;
				mappingVersion: number;
			};
		};
		const provenance = manifest.provenance;
		const importKey = [
			provenance.providerId,
			provenance.sourceSessionId,
			provenance.sourceSha256,
			provenance.converterVersion,
			provenance.sanitizerVersion,
			provenance.mappingVersion,
		].join(":");
		await fs.rm(setup.targetPath);
		const recoveryDirectory = path.join(
			path.dirname(setup.targetPath),
			".gjc-managed-session-internal",
			"import-staging",
			"transcript-path-uncertain",
		);
		await fs.mkdir(recoveryDirectory, { recursive: true });
		await fs.writeFile(
			path.join(recoveryDirectory, "artifact-recovery.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				artifactDirectory: path.basename(artifactDirectory),
				importKey,
				targetSessionId: setup.targetSessionId,
			})}\n`,
		);
		await fs.mkdir(setup.targetPath);
		const managedDirectory = path.dirname(setup.targetPath);
		const before = (await fs.readdir(managedDirectory)).sort();

		await source("transcript-path-blocked", workspace, [message("assistant", "transcript blocked")]);
		expect(await importCodexSessions(workspace, ["transcript-path-blocked"])).toMatchObject({
			status: "failed",
			results: [{ status: "failed", code: "publish_uncertain", phase: "internal", retryable: true }],
		});
		expect((await fs.lstat(setup.targetPath)).isDirectory()).toBe(true);
		expect((await fs.lstat(recoveryDirectory)).isDirectory()).toBe(true);
		expect((await fs.readdir(managedDirectory)).sort()).toEqual(before);
	});
	it("recovers only receipt-bound committed artifacts and preserves unbound directories", async () => {
		await source("staging-orphan", workspace, [message("assistant", "recover staging")]);
		const first = await importCodexSessions(workspace, ["staging-orphan"]);
		const result = first.results[0];
		if (!result || result.status === "failed") throw new Error("Expected import success");
		const artifactDirectory = result.targetPath.slice(0, -6);
		const manifest = JSON.parse(
			await fs.readFile(path.join(artifactDirectory, "codex-import-manifest.json"), "utf8"),
		) as {
			provenance: {
				providerId: string;
				sourceSessionId: string;
				sourceSha256: string;
				converterVersion: number;
				sanitizerVersion: number;
				mappingVersion: number;
			};
		};
		const provenance = manifest.provenance;
		const importKey = [
			provenance.providerId,
			provenance.sourceSessionId,
			provenance.sourceSha256,
			provenance.converterVersion,
			provenance.sanitizerVersion,
			provenance.mappingVersion,
		].join(":");

		await fs.rm(result.targetPath);
		const recoveryDirectory = path.join(
			path.dirname(result.targetPath),
			".gjc-managed-session-internal",
			"import-staging",
			"crashed-attempt",
		);
		await fs.mkdir(recoveryDirectory, { recursive: true });
		await fs.writeFile(
			path.join(recoveryDirectory, "artifact-recovery.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				artifactDirectory: path.basename(artifactDirectory),
				importKey,
				targetSessionId: result.targetSessionId,
			})}\n`,
		);
		expect(await importCodexSessions(workspace, ["staging-orphan"])).toMatchObject({
			status: "success",
			results: [{ status: "imported", targetSessionId: result.targetSessionId }],
		});

		await fs.rm(result.targetPath);
		await fs.writeFile(path.join(artifactDirectory, "unbound-user-data"), "preserve me");
		await fs.rm(path.join(codexHome, "sessions", "2026", "staging-orphan.jsonl"));
		expect(await importCodexSessions(workspace, [])).toMatchObject({
			status: "failed",
			results: [{ code: "source_not_found" }],
		});
		expect(await fs.readFile(path.join(artifactDirectory, "unbound-user-data"), "utf8")).toBe("preserve me");
	});
	it("fails closed when a recovery artifact is swapped after manifest authorization", async () => {
		await source("recovery-swap", workspace, [message("assistant", "recover safely")]);
		const first = await importCodexSessions(workspace, ["recovery-swap"]);
		const result = first.results[0];
		if (!result || result.status === "failed") throw new Error("Expected import success");
		const artifactDirectory = result.targetPath.slice(0, -6);
		const manifest = JSON.parse(
			await fs.readFile(path.join(artifactDirectory, "codex-import-manifest.json"), "utf8"),
		) as {
			provenance: {
				providerId: string;
				sourceSessionId: string;
				sourceSha256: string;
				converterVersion: number;
				sanitizerVersion: number;
				mappingVersion: number;
			};
		};
		const importKey = [
			manifest.provenance.providerId,
			manifest.provenance.sourceSessionId,
			manifest.provenance.sourceSha256,
			manifest.provenance.converterVersion,
			manifest.provenance.sanitizerVersion,
			manifest.provenance.mappingVersion,
		].join(":");
		await fs.rm(result.targetPath);
		const recoveryDirectory = path.join(
			path.dirname(result.targetPath),
			".gjc-managed-session-internal",
			"import-staging",
			"swap-attempt",
		);
		await fs.mkdir(recoveryDirectory, { recursive: true });
		await fs.writeFile(
			path.join(recoveryDirectory, "artifact-recovery.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				artifactDirectory: path.basename(artifactDirectory),
				importKey,
				targetSessionId: result.targetSessionId,
			})}\n`,
		);

		const readExpected = ManagedSessionDescendantStore.prototype.readExpected;
		let swapped = false;
		const spy = vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath: string,
		) {
			const snapshot = readExpected.call(this, relativePath);
			if (!swapped && relativePath.endsWith("/codex-import-manifest.json")) {
				swapped = true;
				nodeFs.renameSync(artifactDirectory, `${artifactDirectory}-authorized`);
				nodeFs.mkdirSync(artifactDirectory);
				nodeFs.writeFileSync(path.join(artifactDirectory, "unrelated"), "preserve");
			}
			return snapshot;
		});
		try {
			expect(await importCodexSessions(workspace, ["recovery-swap"])).toMatchObject({
				status: "failed",
			});
			expect(await fs.readFile(path.join(artifactDirectory, "unrelated"), "utf8")).toBe("preserve");
		} finally {
			spy.mockRestore();
		}
	});
	it("preserves an unbound destination that wins the artifact move race", async () => {
		await source("publish-collision", workspace, [message("assistant", "do not delete collision")]);
		const moveTree = ManagedSessionDescendantStore.prototype.moveTreeNoReplace;
		let collisionPath: string | undefined;
		const spy = vi.spyOn(ManagedSessionDescendantStore.prototype, "moveTreeNoReplace").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			sourceRelativePath,
			destinationRelativePath,
			expected,
		) {
			if (!collisionPath) {
				const sessionsRoot = getSessionsDir(getAgentDir());
				const scopeName = nodeFs
					.readdirSync(sessionsRoot, { withFileTypes: true })
					.find(entry => entry.isDirectory())?.name;
				if (!scopeName) throw new Error("Expected managed scope");
				collisionPath = path.join(sessionsRoot, scopeName, destinationRelativePath);
				nodeFs.mkdirSync(collisionPath);
				nodeFs.writeFileSync(path.join(collisionPath, "unrelated"), "preserve");
			}
			return moveTree.call(this, sourceRelativePath, destinationRelativePath, expected);
		});
		try {
			expect(await importCodexSessions(workspace, ["publish-collision"])).toMatchObject({
				status: "failed",
				results: [{ code: "destination_conflict" }],
			});
			if (!collisionPath) throw new Error("Expected collision injection");
			expect(await fs.readFile(path.join(collisionPath, "unrelated"), "utf8")).toBe("preserve");
		} finally {
			spy.mockRestore();
		}
	});
	it("rejects a converted transcript that cannot be resumed within the context budget", async () => {
		const exactBytes = 134_002_143;
		const id = "large";
		const dir = path.join(codexHome, "sessions", "2026");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, `${id}.jsonl`);
		const handle = await fs.open(file, "wx", 0o600);
		try {
			const header = Buffer.from(meta(id, workspace));
			const full = Buffer.from(message("assistant", "x".repeat(3 * 1024 * 1024)));
			await handle.write(header);
			let written = header.byteLength;
			while (exactBytes - written >= full.byteLength * 2) {
				await handle.write(full);
				written += full.byteLength;
			}
			const emptyBytes = Buffer.byteLength(message("assistant", ""));
			const remaining = exactBytes - written;
			await handle.write(Buffer.from(message("assistant", "y".repeat(remaining - emptyBytes))));
			await handle.sync();
		} finally {
			await handle.close();
		}
		expect((await fs.stat(file)).size).toBe(exactBytes);
		expect(await importCodexSessions(workspace, [id])).toMatchObject({
			status: "failed",
			results: [{ code: "content_too_large", phase: "source_event" }],
		});
	});
	it("sanitizes a large credential-free payload in linear time", () => {
		// The URL-credential rule accepted an unbounded scheme before the literal
		// `://`, so a long run of scheme characters was re-tried at every prefix:
		// quadratic in input length (25k/50k/100k cost 83ms/332ms/1329ms). The rule
		// sits behind an `includes("://")` guard, so the payload must carry one URL
		// for the scan to be reached at all. Imported Codex transcripts are external
		// content and are not length-bounded before this runs.
		for (const body of [`https://ok/ ${"a-b.c+".repeat(16_000)}`, `https://ok/ ${"x".repeat(96_000)}`]) {
			const startedAt = performance.now();
			const out = sanitizeImportedString(body);
			const elapsedMs = performance.now() - startedAt;
			expect(out.redacted).toBe(0);
			expect(elapsedMs).toBeLessThan(1_000);
		}
	});

	it("still redacts url userinfo across real scheme shapes", () => {
		for (const [input, secret] of [
			["https://alice:https-secret-value@example.com/x", "https-secret-value"],
			["postgres://svc:pg-secret-value@db.internal:5432/app", "pg-secret-value"],
			["git+ssh://deploy:ssh-secret-value@git.example.com/x.git", "ssh-secret-value"],
		] as const) {
			const { value } = sanitizeImportedString(input);
			expect(value).not.toContain(secret);
			expect(value).toContain(input.slice(0, input.indexOf("://") + 3));
		}
	});
});
