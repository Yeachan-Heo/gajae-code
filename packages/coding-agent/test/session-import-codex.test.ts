import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	closeCodexSessionAuthorities,
	convertCodexSession,
	discoverCodexSessions,
	sanitizeImportedString,
	sanitizeImportedValue,
} from "../src/session-import/codex";
import { importCodexSessions } from "../src/session-import/service";
import {
	executeBuiltinSlashCommand,
	executeLocalHeadlessBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";
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
	await fs.mkdir(dir, { recursive: true });
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
	setAgentDir(path.join(root, "agent"));
	process.env.CODEX_HOME = codexHome;
});

afterEach(async () => {
	delete process.env.CODEX_HOME;
	setAgentDir(originalAgentDir);
	for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true });
});

describe("Codex session import", () => {
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

	it("returns a failing local-headless status when import discovery fails", async () => {
		const output: string[] = [];
		const result = await executeLocalHeadlessBuiltinSlashCommand("/import-session codex missing-id", {
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

	it("rejects symlinked and hard-linked Codex sources", async () => {
		await source("safe-source", workspace, [message("user", "safe")]);
		await source("hard-linked", workspace, [message("user", "unsafe")]);
		const directory = path.join(codexHome, "sessions", "2026");
		await fs.symlink(path.join(directory, "safe-source.jsonl"), path.join(directory, "symlink-source.jsonl"));
		await fs.link(path.join(directory, "hard-linked.jsonl"), path.join(directory, "hard-linked-copy.jsonl"));

		expect((await discoverCodexSessions(workspace, ["safe-source"], codexHome)).map(value => value.id)).toEqual([
			"safe-source",
		]);
		await expect(discoverCodexSessions(workspace, ["hard-linked"], codexHome)).rejects.toMatchObject({
			code: "source_not_found",
		});
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
	it("imports an exact 70,002,143-byte source through checkpoint, restart, continuation, and retry", async () => {
		const exactBytes = 70_002_143;
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
			const final = Buffer.from(message("assistant", "y".repeat(remaining - emptyBytes)));
			expect(final.byteLength).toBe(remaining);
			await handle.write(final);
			await handle.sync();
		} finally {
			await handle.close();
		}
		expect((await fs.stat(file)).size).toBe(exactBytes);
		const batch = await importCodexSessions(workspace, [id]);
		if (batch.status !== "success") throw new Error(JSON.stringify(batch));
		expect(batch.status).toBe("success");
		const result = batch.results[0];
		if (!result || result.status === "failed") throw new Error("Expected large import success");
		expect(result.transcriptBytes).toBeGreaterThan(64 * 1024 * 1024);
		let resumePromise: ReturnType<typeof SessionManager.openExistingStrict> | undefined;
		expect(
			await executeBuiltinSlashCommand("/resume", {
				ctx: {
					showSessionSelector: () => {
						resumePromise = (async () => {
							const inspection = await SessionManager.inspectSessionTailReadOnly(result.targetPath);
							if (inspection.kind === "error") throw new Error(inspection.reason);
							return SessionManager.openExistingStrict(inspection.identity, path.dirname(result.targetPath));
						})();
					},
					editor: { setText: () => undefined },
				},
				handleBackgroundCommand: () => undefined,
			} as unknown as Parameters<typeof executeBuiltinSlashCommand>[1]),
		).toBe(true);
		if (!resumePromise) throw new Error("/resume did not open the session selector");
		const opened = await resumePromise;
		if (opened.kind === "error") throw new Error(opened.reason);
		const lease = opened.manager.acquireMemoryGuardParticipantIngressLease();
		try {
			const checkpoint = await opened.manager.createMemoryGuardCheckpoint({
				ingressLease: lease,
				checkpointRoot: path.join(root, "checkpoint"),
			});
			expect(Number(checkpoint.transcript.bytes)).toBeGreaterThan(64 * 1024 * 1024);
		} finally {
			lease.release();
		}
		opened.manager.appendMessage({ role: "user", content: "large continuation", timestamp: 2 });
		await opened.manager.close();
		const restarted = await SessionManager.inspectSessionTailReadOnly(result.targetPath);
		if (restarted.kind === "error") throw new Error(restarted.reason);
		const reopened = await SessionManager.openExistingStrict(restarted.identity, path.dirname(result.targetPath));
		if (reopened.kind === "error") throw new Error(reopened.reason);
		expect(reopened.manager.buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: "large continuation",
		});
		await reopened.manager.close();
		const retry = await importCodexSessions(workspace, [id]);
		expect(retry.status).toBe("existing");
		const finalInspection = await SessionManager.inspectSessionTailReadOnly(result.targetPath);
		if (finalInspection.kind === "error") throw new Error(finalInspection.reason);
		const finalReopen = await SessionManager.openExistingStrict(
			finalInspection.identity,
			path.dirname(result.targetPath),
		);
		if (finalReopen.kind === "error") throw new Error(finalReopen.reason);
		expect(finalReopen.manager.buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: "large continuation",
		});
		await finalReopen.manager.close();
	}, 300_000);
});
