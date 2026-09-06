/**
 * Deterministic fixture-driven tests for the provider-neutral session import
 * (issue #3709): format detection, Codex/Claude adapters, fail-closed
 * redaction, bounds, provenance persistence, collision handling, and the
 * `/import-session` command surface.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canContinuePersistedHistory } from "@gajae-code/agent-core";
import { SessionManager } from "../src/session/session-manager";
import { parseImportSessionArgs } from "../src/session-import/command";
import { detectSessionImportFormat } from "../src/session-import/detect";
import {
	EXTERNAL_IMPORT_CONTEXT_CUSTOM_TYPE,
	EXTERNAL_IMPORT_PROVENANCE_CUSTOM_TYPE,
	EXTERNAL_IMPORT_SOURCE_MAX_BYTES,
	formatProviderSessionImportSummary,
	importProviderSessionFile,
	prepareExternalSessionImport,
} from "../src/session-import/provider-service";
import { redactImportedText } from "../src/session-import/redact";
import { SessionImportError, type SessionImportProvenance } from "../src/session-import/types";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const CODEX_SESSION_ID = "019cabcd-1111-7222-8333-444455556666";
const CLAUDE_SESSION_ID = "c4d4e5f6-1111-4222-8333-444455556666";
const CLAUDE_EXPORT_ID = "b1b2c3d4-1111-4222-8333-444455556666";

const CODEX_ROLLOUT = [
	JSON.stringify({
		timestamp: "2026-07-30T10:00:00.000Z",
		type: "session_meta",
		payload: {
			id: CODEX_SESSION_ID,
			timestamp: "2026-07-30T10:00:00.000Z",
			cwd: "/home/dev/project",
			originator: "codex_cli_rs",
			cli_version: "0.44.0",
			title: "Fix login redirect",
		},
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:00:05.000Z",
		type: "turn_context",
		payload: { cwd: "/home/dev/project", model: "gpt-5.1-codex" },
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:01:00.000Z",
		type: "response_item",
		payload: {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "The login redirect drops the token parameter. Investigate and fix." }],
		},
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:01:30.000Z",
		type: "response_item",
		payload: { type: "reasoning", summary: [] },
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:02:00.000Z",
		type: "response_item",
		payload: {
			type: "message",
			role: "assistant",
			content: [
				{ type: "output_text", text: "Found it: the callback handler rebuilds the URL without query params." },
			],
		},
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:02:30.000Z",
		type: "response_item",
		payload: {
			type: "function_call",
			name: "exec_command",
			arguments: JSON.stringify({ command: ["sed", "-n", "1,40p", "src/auth.ts"] }),
			call_id: "call_1",
		},
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:02:31.000Z",
		type: "response_item",
		payload: { type: "function_call_output", call_id: "call_1", output: "export function callback() { ... }" },
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:03:00.000Z",
		type: "response_item",
		payload: {
			type: "message",
			role: "assistant",
			content: [
				{ type: "output_text", text: "Fixed by preserving the query string. Remaining: add a regression test." },
			],
		},
	}),
	JSON.stringify({
		timestamp: "2026-07-30T10:04:00.000Z",
		type: "response_item",
		payload: { type: "mystery_future_record", data: {} },
	}),
].join("\n");

const CLAUDE_CODE_TRANSCRIPT = [
	JSON.stringify({ type: "summary", summary: "Login redirect token fix", leafUuid: "leaf-1" }),
	JSON.stringify({
		parentUuid: null,
		isSidechain: false,
		userType: "external",
		cwd: "/home/dev/project",
		sessionId: CLAUDE_SESSION_ID,
		version: "2.0.5",
		type: "user",
		message: { role: "user", content: "The login redirect drops the token parameter. Investigate and fix." },
		uuid: "u1",
		timestamp: "2026-07-30T10:01:00.000Z",
	}),
	JSON.stringify({
		parentUuid: "u1",
		isSidechain: false,
		cwd: "/home/dev/project",
		sessionId: CLAUDE_SESSION_ID,
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-sonnet-4.6",
			content: [
				{ type: "thinking", thinking: "internal reasoning never imported" },
				{ type: "text", text: "Found it: the callback handler drops query params." },
				{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/home/dev/project/src/auth.ts" } },
			],
		},
		uuid: "a1",
		timestamp: "2026-07-30T10:02:00.000Z",
	}),
	JSON.stringify({
		parentUuid: "a1",
		isSidechain: false,
		cwd: "/home/dev/project",
		sessionId: CLAUDE_SESSION_ID,
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export function callback() { ... }" }],
		},
		uuid: "u2",
		timestamp: "2026-07-30T10:02:30.000Z",
	}),
	JSON.stringify({
		parentUuid: "u2",
		isSidechain: false,
		cwd: "/home/dev/project",
		sessionId: CLAUDE_SESSION_ID,
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-sonnet-4.6",
			content: [{ type: "text", text: "Fixed by preserving the query string. Remaining: add a regression test." }],
		},
		uuid: "a2",
		timestamp: "2026-07-30T10:03:00.000Z",
	}),
	JSON.stringify({
		parentUuid: "a2",
		isSidechain: false,
		cwd: "/home/dev/project",
		sessionId: CLAUDE_SESSION_ID,
		type: "system",
		subtype: "compact_boundary",
		content: "Compacted",
		uuid: "s1",
		timestamp: "2026-07-30T10:04:00.000Z",
	}),
	JSON.stringify({
		parentUuid: "s1",
		isSidechain: false,
		cwd: "/home/dev/project",
		sessionId: CLAUDE_SESSION_ID,
		type: "user",
		isMeta: true,
		message: { role: "user", content: "<command-name>/compact</command-name>" },
		uuid: "u3",
		timestamp: "2026-07-30T10:04:05.000Z",
	}),
	JSON.stringify({ type: "unknown_future_record", data: {} }),
].join("\n");

const CLAUDE_EXPORT = JSON.stringify([
	{
		uuid: CLAUDE_EXPORT_ID,
		name: "Login redirect token fix",
		created_at: "2026-07-30T10:00:00.000Z",
		updated_at: "2026-07-30T10:05:00.000Z",
		chat_messages: [
			{
				uuid: "m1",
				sender: "human",
				created_at: "2026-07-30T10:01:00.000Z",
				content: [{ type: "text", text: "The login redirect drops the token parameter. Investigate and fix." }],
			},
			{
				uuid: "m2",
				sender: "assistant",
				created_at: "2026-07-30T10:02:00.000Z",
				content: [{ type: "text", text: "Found it: the callback handler drops query params." }],
			},
		],
	},
]);

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-import-"));
	tempDirs.push(dir);
	return dir;
}

function writeSource(dir: string, name: string, content: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, content, "utf8");
	return file;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function expectImportError(error: unknown, code: SessionImportError["code"]): SessionImportError {
	expect(error).toBeInstanceOf(SessionImportError);
	const importError = error as SessionImportError;
	expect(importError.code).toBe(code);
	return importError;
}

describe("session import format detection", () => {
	it("detects a Codex rollout transcript", () => {
		expect(detectSessionImportFormat(CODEX_ROLLOUT, undefined)).toEqual({
			provider: "codex",
			format: "codex-rollout-jsonl",
		});
	});

	it("detects a Claude Code transcript", () => {
		expect(detectSessionImportFormat(CLAUDE_CODE_TRANSCRIPT, undefined)).toEqual({
			provider: "claude",
			format: "claude-code-jsonl",
		});
	});

	it("detects a claude.ai conversation export", () => {
		expect(detectSessionImportFormat(CLAUDE_EXPORT, undefined)).toEqual({
			provider: "claude",
			format: "claude-export-json",
		});
	});

	it("rejects a native GJC session transcript with an actionable error", () => {
		const gjcSession = `${JSON.stringify({ type: "session", version: 5, id: "abc", timestamp: "2026-07-30T10:00:00.000Z", cwd: "/tmp" })}\n`;
		try {
			detectSessionImportFormat(gjcSession, undefined);
			expect.unreachable();
		} catch (error) {
			expectImportError(error, "unsupported_format");
		}
	});

	it("rejects unrecognized content instead of guessing", () => {
		try {
			detectSessionImportFormat("hello world, this is not a transcript\n", undefined);
			expect.unreachable();
		} catch (error) {
			expectImportError(error, "unsupported_format");
		}
	});

	it("fails closed when the explicit provider contradicts the detected format", () => {
		try {
			detectSessionImportFormat(CLAUDE_CODE_TRANSCRIPT, "codex");
			expect.unreachable();
		} catch (error) {
			const importError = expectImportError(error, "format_mismatch");
			expect(importError.message).toContain("claude");
		}
	});

	it("honors an explicit provider matching the detected format", () => {
		expect(detectSessionImportFormat(CODEX_ROLLOUT, "codex").provider).toBe("codex");
	});
});

describe("Codex import normalization", () => {
	it("maps messages, tool evidence, and provenance; quarantines unknown records", async () => {
		const dir = makeTempDir();
		const source = writeSource(dir, "rollout-2026-07-30T10-00-00.jsonl", CODEX_ROLLOUT);
		const prepared = await prepareExternalSessionImport({ sourcePath: source });

		expect(prepared.conversation.provider).toBe("codex");
		expect(prepared.conversation.format).toBe("codex-rollout-jsonl");
		expect(prepared.conversation.sourceSessionId).toBe(CODEX_SESSION_ID);
		expect(prepared.conversation.title).toBe("Fix login redirect");
		expect(prepared.conversation.messages).toHaveLength(2);
		expect(prepared.conversation.messages[0]!.role).toBe("user");
		expect(prepared.conversation.messages[0]!.text).toContain("drops the token parameter");
		expect(prepared.conversation.messages[1]!.role).toBe("assistant");
		expect(prepared.conversation.messages[1]!.text).toContain("without query params");
		expect(prepared.conversation.messages[1]!.text).toContain("preserving the query string");
		expect(prepared.conversation.messages[1]!.toolEvidence).toEqual([
			"$ exec_command sed -n 1,40p src/auth.ts",
			"→ export function callback() { ... }",
		]);

		// Unknown record is quarantined with a digest, never silently dropped.
		expect(prepared.counts.quarantined).toBe(1);
		expect(prepared.provenance.quarantine.present).toBe(true);
		expect(prepared.counts.mapped).toBe(8);

		expect(prepared.provenance.provider).toBe("codex");
		expect(prepared.provenance.sourceFileName).toBe("rollout-2026-07-30T10-00-00.jsonl");
		expect(prepared.sourceSha256).toBe(createHash("sha256").update(CODEX_ROLLOUT, "utf8").digest("hex"));
		expect(prepared.contextText).toContain('<imported-session provider="codex"');
		expect(prepared.contextText).toContain("drops the token parameter");
		expect(prepared.contextText).toContain("</imported-session>");
	});

	it("quarantines malformed lines but still imports the valid conversation", async () => {
		const dir = makeTempDir();
		const broken = `${CODEX_ROLLOUT.split("\n").slice(0, 3).join("\n")}\n{not json\n${CODEX_ROLLOUT.split("\n").slice(3, 5).join("\n")}`;
		const source = writeSource(dir, "rollout.jsonl", broken);
		const prepared = await prepareExternalSessionImport({ sourcePath: source });
		expect(prepared.counts.quarantined).toBe(1);
		expect(prepared.conversation.messages.length).toBeGreaterThan(0);
	});
});

describe("Claude import normalization", () => {
	it("maps Claude Code transcripts with summaries, tool evidence, and meta filtering", async () => {
		const dir = makeTempDir();
		const source = writeSource(dir, `${CLAUDE_SESSION_ID}.jsonl`, CLAUDE_CODE_TRANSCRIPT);
		const prepared = await prepareExternalSessionImport({ sourcePath: source });

		expect(prepared.conversation.provider).toBe("claude");
		expect(prepared.conversation.format).toBe("claude-code-jsonl");
		expect(prepared.conversation.sourceSessionId).toBe(CLAUDE_SESSION_ID);
		expect(prepared.conversation.title).toBe("Login redirect token fix");
		expect(prepared.conversation.messages).toHaveLength(2);
		expect(prepared.conversation.messages[0]!.role).toBe("user");
		expect(prepared.conversation.messages[1]!.role).toBe("assistant");
		// Thinking blocks are model-internal and never imported.
		expect(prepared.conversation.messages[1]!.text).not.toContain("internal reasoning");
		expect(prepared.conversation.messages[1]!.toolEvidence).toEqual([
			"$ Read /home/dev/project/src/auth.ts",
			"→ export function callback() { ... }",
		]);
		// isMeta command rows and the unknown record never enter the conversation.
		expect(prepared.contextText).not.toContain("/compact");
		expect(prepared.counts.quarantined).toBe(1);
	});

	it("maps claude.ai exports with conversation metadata", async () => {
		const dir = makeTempDir();
		const source = writeSource(dir, "conversations.json", CLAUDE_EXPORT);
		const prepared = await prepareExternalSessionImport({ sourcePath: source });

		expect(prepared.conversation.provider).toBe("claude");
		expect(prepared.conversation.format).toBe("claude-export-json");
		expect(prepared.conversation.sourceSessionId).toBe(CLAUDE_EXPORT_ID);
		expect(prepared.conversation.title).toBe("Login redirect token fix");
		expect(prepared.conversation.messages).toHaveLength(2);
		expect(prepared.conversation.messages[0]!.role).toBe("user");
		expect(prepared.conversation.messages[1]!.role).toBe("assistant");
	});

	it("accepts a single-conversation export object", async () => {
		const dir = makeTempDir();
		const source = writeSource(dir, "conversation.json", JSON.stringify(JSON.parse(CLAUDE_EXPORT)[0]));
		const prepared = await prepareExternalSessionImport({ sourcePath: source, provider: "claude" });
		expect(prepared.conversation.messages).toHaveLength(2);
	});
});

describe("import redaction", () => {
	it("redacts credentials, tokens, keys, and environment secrets fail-closed", () => {
		const input = [
			"anthropic: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG",
			"openai: sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
			"aws: AKIAIOSFODNN7EXAMPLE",
			"github: ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII",
			"jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----",
			"Authorization: Bearer abcdef1234567890abcdef",
			"url: https://user:passw0rd@example.com/path",
			"OPENAI_API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA",
			"password: hunter2hunter2",
		].join("\n");
		const result = redactImportedText(input);
		expect(result.redacted).toBeGreaterThanOrEqual(10);
		expect(result.kinds.length).toBeGreaterThan(0);
		expect(result.value).not.toContain("sk-ant-");
		expect(result.value).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(result.value).not.toContain("ghp_");
		expect(result.value).not.toContain("eyJhbGci");
		expect(result.value).not.toContain("b3BlbnNzaC1rZXktdjE");
		expect(result.value).not.toContain("abcdef1234567890abcdef");
		expect(result.value).not.toContain("passw0rd");
		expect(result.value).not.toContain("hunter2hunter2");
		expect(result.value).not.toContain("sk-AAAAAAAAAAAAAAAAAAAAAAAA");
		// Non-secret content survives untouched.
		const benign = redactImportedText("The callback handler drops query parameters.");
		expect(benign.redacted).toBe(0);
		expect(benign.value).toBe("The callback handler drops query parameters.");
	});

	it("scans a large credential-free body in linear time", () => {
		// The url-credential rule used to accept an unbounded scheme before the
		// literal `://`, so a long alphabetic run re-tried every prefix: cost grew
		// quadratically (50k/100k/200k = 0.7s/2.7s/10.6s) on text holding no
		// credential at all. Every imported string crosses this function, so a
		// single large transcript message stalled the whole import.
		const body = "x".repeat(200_000);
		const startedAt = performance.now();
		const result = redactImportedText(body);
		const elapsedMs = performance.now() - startedAt;

		expect(result.redacted).toBe(0);
		expect(result.value).toBe(body);
		// Linear scanning lands near 1ms; the pre-fix pattern needed ~10_600ms.
		// The budget is deliberately loose so it fails only on quadratic scanning.
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("still redacts url credentials across real scheme shapes", () => {
		const cases = [
			["https://alice:hunter2hunter2@example.com/repo.git", "hunter2hunter2"],
			["postgres://svc:s3cr3tvalue@db.internal:5432/app", "s3cr3tvalue"],
			["git+ssh://deploy:tokenvalue123@git.example.com/x.git", "tokenvalue123"],
		] as const;
		for (const [input, secret] of cases) {
			const result = redactImportedText(input);
			expect(result.value).not.toContain(secret);
			expect(result.kinds).toContain("url-credential");
			// The scheme and host stay readable; only the userinfo is dropped.
			expect(result.value).toContain(input.slice(0, input.indexOf("://") + 3));
		}
	});

	it("applies redaction to imported context and reports the count", async () => {
		const dir = makeTempDir();
		const withSecret = `${CODEX_ROLLOUT}\n${JSON.stringify({
			timestamp: "2026-07-30T10:05:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "I used OPENAI_API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA to test." }],
			},
		})}`;
		const source = writeSource(dir, "rollout.jsonl", withSecret);
		const prepared = await prepareExternalSessionImport({ sourcePath: source });
		expect(prepared.counts.redacted).toBeGreaterThanOrEqual(2);
		expect(prepared.contextText).not.toContain("sk-AAAAAAAAAAAAAAAAAAAAAAAA");
		expect(prepared.redactionKinds).toContain("secret-assignment");
	});
});

describe("import bounds and malformed input", () => {
	it("fails source_not_found for a missing file", async () => {
		const dir = makeTempDir();
		try {
			await prepareExternalSessionImport({ sourcePath: path.join(dir, "missing.jsonl") });
			expect.unreachable();
		} catch (error) {
			expectImportError(error, "source_not_found");
		}
	});

	it("fails invalid_request for a directory source", async () => {
		const dir = makeTempDir();
		try {
			await prepareExternalSessionImport({ sourcePath: dir });
			expect.unreachable();
		} catch (error) {
			expectImportError(error, "invalid_request");
		}
	});

	it("fails malformed_input for an empty file", async () => {
		const dir = makeTempDir();
		const source = writeSource(dir, "empty.jsonl", "");
		try {
			await prepareExternalSessionImport({ sourcePath: source });
			expect.unreachable();
		} catch (error) {
			expectImportError(error, "malformed_input");
		}
	});

	it("fails malformed_input when no importable messages exist", async () => {
		const dir = makeTempDir();
		const metaOnly = JSON.stringify({
			timestamp: "2026-07-30T10:00:00.000Z",
			type: "session_meta",
			payload: { id: CODEX_SESSION_ID, timestamp: "2026-07-30T10:00:00.000Z", cwd: "/tmp" },
		});
		const source = writeSource(dir, "rollout.jsonl", metaOnly);
		try {
			await prepareExternalSessionImport({ sourcePath: source });
			expect.unreachable();
		} catch (error) {
			expectImportError(error, "malformed_input");
		}
	});

	it("fails content_too_large over the message limit", async () => {
		const dir = makeTempDir();
		const lines = [
			JSON.stringify({
				timestamp: "2026-07-30T10:00:00.000Z",
				type: "session_meta",
				payload: { id: CODEX_SESSION_ID, timestamp: "2026-07-30T10:00:00.000Z", cwd: "/tmp" },
			}),
		];
		for (let index = 0; index < 5001; index++) {
			lines.push(
				JSON.stringify({
					timestamp: "2026-07-30T10:01:00.000Z",
					type: "response_item",
					payload: {
						type: "message",
						role: index % 2 === 0 ? "user" : "assistant",
						content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: `message ${index}` }],
					},
				}),
			);
		}
		const source = writeSource(dir, "rollout.jsonl", lines.join("\n"));
		try {
			await prepareExternalSessionImport({ sourcePath: source });
			expect.unreachable();
		} catch (error) {
			const importError = expectImportError(error, "content_too_large");
			expect(importError.observedBytes).toBe(5001);
		}
	});

	it("fails content_too_large over the source byte limit", async () => {
		const dir = makeTempDir();
		const source = path.join(dir, "huge.jsonl");
		fs.writeFileSync(source, Buffer.alloc(EXTERNAL_IMPORT_SOURCE_MAX_BYTES + 1, 0x61));
		try {
			await prepareExternalSessionImport({ sourcePath: source });
			expect.unreachable();
		} catch (error) {
			const importError = expectImportError(error, "content_too_large");
			expect(importError.limitBytes).toBe(EXTERNAL_IMPORT_SOURCE_MAX_BYTES);
		}
	});

	it("bounds oversized conversations with a deterministic elision marker", async () => {
		const dir = makeTempDir();
		const lines = [
			JSON.stringify({
				timestamp: "2026-07-30T10:00:00.000Z",
				type: "session_meta",
				payload: { id: CODEX_SESSION_ID, timestamp: "2026-07-30T10:00:00.000Z", cwd: "/tmp" },
			}),
		];
		for (let index = 0; index < 12; index++) {
			lines.push(
				JSON.stringify({
					timestamp: "2026-07-30T10:01:00.000Z",
					type: "response_item",
					payload: {
						type: "message",
						role: index % 2 === 0 ? "user" : "assistant",
						content: [
							{
								type: index % 2 === 0 ? "input_text" : "output_text",
								text: `turn-${index} ${"x".repeat(24 * 1024)}`,
							},
						],
					},
				}),
			);
		}
		const source = writeSource(dir, "rollout.jsonl", lines.join("\n"));
		const prepared = await prepareExternalSessionImport({ sourcePath: source });
		expect(prepared.provenance.truncated).toBe(true);
		expect(prepared.counts.omitted).toBeGreaterThan(0);
		expect(prepared.contextText).toContain("elided");
		// The head (first turn) and the continuation tail (last turn) survive.
		expect(prepared.contextText).toContain("turn-0");
		expect(prepared.contextText).toContain("turn-11");
		expect(prepared.contextText.length).toBeLessThanOrEqual(120_000 + 4_096);
	});
});

describe("session import materialization", () => {
	it("creates a provenance-marked GJC session that reopens continuable", async () => {
		const dir = makeTempDir();
		const destination = path.join(dir, "sessions");
		const source = writeSource(dir, "rollout.jsonl", CODEX_ROLLOUT);
		const sourceShaBefore = createHash("sha256").update(fs.readFileSync(source)).digest("hex");

		const result = await importProviderSessionFile({
			sourcePath: source,
			cwd: dir,
			destination,
			now: () => new Date("2026-08-01T09:00:00.000Z"),
		});
		expect(fs.existsSync(result.targetPath)).toBe(true);
		expect(result.title).toBe("Fix login redirect");

		const lines = fs.readFileSync(result.targetPath, "utf8").trim().split("\n");
		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");
		expect(header.id).toBe(result.targetSessionId);
		expect(header.cwd).toBe(dir);

		const provenanceEntry = lines
			.map(line => JSON.parse(line))
			.find(entry => entry.type === "custom" && entry.customType === EXTERNAL_IMPORT_PROVENANCE_CUSTOM_TYPE);
		expect(provenanceEntry).toBeDefined();
		const provenance = provenanceEntry.data as SessionImportProvenance;
		expect(provenance.schemaVersion).toBe(1);
		expect(provenance.provider).toBe("codex");
		expect(provenance.format).toBe("codex-rollout-jsonl");
		expect(provenance.sourceSha256).toBe(sourceShaBefore);
		expect(provenance.sourceSessionId).toBe(CODEX_SESSION_ID);
		expect(provenance.targetSessionId).toBe(result.targetSessionId);
		expect(provenance.importedAt).toBe("2026-08-01T09:00:00.000Z");
		expect(provenance.counts.mapped).toBe(8);
		expect(provenance.counts.quarantined).toBe(1);

		const contextEntry = lines
			.map(line => JSON.parse(line))
			.find(entry => entry.type === "custom_message" && entry.customType === EXTERNAL_IMPORT_CONTEXT_CUSTOM_TYPE);
		expect(contextEntry).toBeDefined();
		expect(contextEntry.display).toBe(true);
		expect(contextEntry.content).toContain("drops the token parameter");
		expect(contextEntry.content).toContain("preserving the query string");

		const reopened = await SessionManager.open(result.targetPath, destination);
		try {
			const context = reopened.buildSessionContext();
			expect(reopened.getSessionName()).toBe("Fix login redirect");
			expect(canContinuePersistedHistory(context.messages)).toBe(true);
			expect(context.messages.some(message => message.role === "custom")).toBe(true);
		} finally {
			await reopened.close();
		}

		// The source transcript is untouched.
		expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(sourceShaBefore);
	});

	it("creates distinct sessions for repeated imports of the same source", async () => {
		const dir = makeTempDir();
		const destination = path.join(dir, "sessions");
		const source = writeSource(dir, "rollout.jsonl", CODEX_ROLLOUT);
		const first = await importProviderSessionFile({ sourcePath: source, cwd: dir, destination });
		const second = await importProviderSessionFile({ sourcePath: source, cwd: dir, destination });
		expect(first.targetSessionId).not.toBe(second.targetSessionId);
		expect(fs.existsSync(first.targetPath)).toBe(true);
		expect(fs.existsSync(second.targetPath)).toBe(true);
	});

	it("materializes a claude.ai export end-to-end", async () => {
		const dir = makeTempDir();
		const destination = path.join(dir, "sessions");
		const source = writeSource(dir, "conversations.json", CLAUDE_EXPORT);
		const result = await importProviderSessionFile({ sourcePath: source, cwd: dir, destination });
		expect(result.title).toBe("Login redirect token fix");
		expect(fs.existsSync(result.targetPath)).toBe(true);
		const summary = formatProviderSessionImportSummary(result);
		expect(summary).toContain("Claude");
		expect(summary).toContain("not modified");
	});

	it("never persists secrets into the new session transcript", async () => {
		const dir = makeTempDir();
		const destination = path.join(dir, "sessions");
		const withSecret = `${CODEX_ROLLOUT}\n${JSON.stringify({
			timestamp: "2026-07-30T10:05:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG worked." }],
			},
		})}`;
		const source = writeSource(dir, "rollout.jsonl", withSecret);
		const result = await importProviderSessionFile({ sourcePath: source, cwd: dir, destination });
		expect(result.prepared.counts.redacted).toBeGreaterThanOrEqual(1);
		const persisted = fs.readFileSync(result.targetPath, "utf8");
		expect(persisted).not.toContain("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG");
		expect(persisted).toContain("[REDACTED]");
	});
});

describe("/import-session command surface", () => {
	it("parses quoted paths and provider flags", () => {
		expect(parseImportSessionArgs('"/tmp/my exports/rollout one.jsonl" --provider codex')).toEqual({
			kind: "ok",
			sourcePath: "/tmp/my exports/rollout one.jsonl",
			provider: "codex",
		});
		expect(parseImportSessionArgs("--provider=claude /tmp/c.jsonl")).toEqual({
			kind: "ok",
			sourcePath: "/tmp/c.jsonl",
			provider: "claude",
		});
		expect(parseImportSessionArgs("/tmp/rollout.jsonl")).toEqual({
			kind: "ok",
			sourcePath: "/tmp/rollout.jsonl",
		});
	});

	it("rejects malformed invocations with usage text", () => {
		expect(parseImportSessionArgs("").kind).toBe("error");
		expect(parseImportSessionArgs("--provider openai /tmp/x.jsonl").kind).toBe("error");
		expect(parseImportSessionArgs("--unknown /tmp/x.jsonl").kind).toBe("error");
		expect(parseImportSessionArgs("/tmp/a.jsonl /tmp/b.jsonl").kind).toBe("error");
	});

	it.skipIf(process.platform !== "linux")("is registered for trusted local dispatch and excluded from ACP", () => {
		const spec = lookupBuiltinSlashCommand("import-session");
		expect(spec).toBeDefined();
		expect(spec?.handle).toBeDefined();
		expect(spec?.acp).toBe(false);
		expect(spec?.localHeadless).toBe(true);
		expect(spec?.allowArgs).toBe(true);
		const acp = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "import-session");
		expect(acp).toBeUndefined();
	});
});
