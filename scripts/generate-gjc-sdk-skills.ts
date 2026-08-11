#!/usr/bin/env bun

import * as fsConstants from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import authorPrompt from "./gjc-sdk-skills/prompts/author.md" with { type: "text" };
import discoverPrompt from "./gjc-sdk-skills/prompts/discover.md" with { type: "text" };
import operatePrompt from "./gjc-sdk-skills/prompts/operate.md" with { type: "text" };

const repoRoot = path.join(import.meta.dir, "..");
const bundleDir = path.join(repoRoot, "sdk-skills");

export const BUNDLE_NAME = "gjc-sdk-skills";
export const BUNDLE_MANIFEST_NAME = "manifest.json";
export const BUNDLE_FORMAT_VERSION = 1;
export const SUPPORTED_BUNDLE_FORMAT_VERSIONS = [BUNDLE_FORMAT_VERSION] as const;

export const ALLOWED_CONTROLS = [
	"turn.prompt",
	"turn.steer",
	"turn.follow_up",
	"ask.answer",
	"workflow.gate_answer",
	"todo.replace",
	"session.switch",
	"session.rename",
] as const;

export const ALLOWED_GLOBALS = ["session.create", "session.fork", "session.resume", "session.close"] as const;

// The three skill prompts are authored as static Markdown sources under
// scripts/gjc-sdk-skills/prompts/ and are imported verbatim. They are the
// canonical prompt-authoring source per AGENTS.md; the generator only copies
// and validates them, it never builds prompt prose inline.

export function bundleContentFiles(files: ReadonlyMap<string, string>): string[] {
	return [...files.keys()].filter(key => key !== BUNDLE_MANIFEST_NAME).sort();
}

function manifestFile(files: ReadonlyMap<string, string>): string {
	return `${JSON.stringify(
		{
			bundle: BUNDLE_NAME,
			formatVersion: BUNDLE_FORMAT_VERSION,
			files: bundleContentFiles(files),
		},
		null,
		2,
	)}\n`;
}

/**
 * Fail-closed validation of a bundle manifest. Returns a human-readable problem
 * (which always contains the `sdk-skills/manifest.json` reference) or null when
 * the manifest declares a supported format version and the exact file closure.
 * Consumers must treat any non-null result as "do not read this bundle".
 */
export function validateBundleManifest(manifestContent: string | null, expectedFiles: readonly string[]): string | null {
	if (manifestContent === null) {
		return `missing: sdk-skills/${BUNDLE_MANIFEST_NAME} (bundle has no format version; regenerate with \`bun run generate-sdk-skills\`)`;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestContent);
	} catch (error) {
		return `invalid: sdk-skills/${BUNDLE_MANIFEST_NAME} (unparseable JSON: ${error instanceof Error ? error.message : String(error)})`;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return `invalid: sdk-skills/${BUNDLE_MANIFEST_NAME} (manifest is not an object)`;
	}
	const record = parsed as Record<string, unknown>;
	if (record.bundle !== BUNDLE_NAME) return `invalid: sdk-skills/${BUNDLE_MANIFEST_NAME} (bundle name mismatch)`;
	if (!Number.isInteger(record.formatVersion)) {
		return `invalid: sdk-skills/${BUNDLE_MANIFEST_NAME} (missing or invalid formatVersion)`;
	}
	const version = record.formatVersion as number;
	if (!(SUPPORTED_BUNDLE_FORMAT_VERSIONS as readonly number[]).includes(version)) {
		return `unsupported: sdk-skills bundle format version ${version} (supported: ${SUPPORTED_BUNDLE_FORMAT_VERSIONS.join(", ")}); regenerate with \`bun run generate-sdk-skills\``;
	}
	if (!Array.isArray(record.files) || !record.files.every(item => typeof item === "string")) {
		return `invalid: sdk-skills/${BUNDLE_MANIFEST_NAME} (files must be an array of relative paths)`;
	}
	const declared = [...(record.files as string[])].sort();
	const expected = [...expectedFiles].sort();
	if (JSON.stringify(declared) !== JSON.stringify(expected)) {
		return `invalid: sdk-skills/${BUNDLE_MANIFEST_NAME} (manifest file list does not match the rendered bundle)`;
	}
	return null;
}

type RegularFileIdentity = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
};

function regularFileIdentity(stat: fsConstants.Stats): RegularFileIdentity | null {
	if (stat.isSymbolicLink() || !stat.isFile()) return null;
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function isSameRegularFileIdentity(first: RegularFileIdentity, second: RegularFileIdentity): boolean {
	return first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeMs === second.mtimeMs;
}

async function readRegularFile(target: string): Promise<string | null> {
	let handle: fs.FileHandle | undefined;
	try {
		const expected = process.platform === "win32" ? regularFileIdentity(await fs.lstat(target)) : undefined;
		if (process.platform === "win32" && !expected) return null;
		handle = await fs.open(
			target,
			fsConstants.constants.O_RDONLY |
				(process.platform === "win32" ? 0 : fsConstants.constants.O_NOFOLLOW | fsConstants.constants.O_NONBLOCK),
		);
		const opened = regularFileIdentity(await handle.stat());
		if (!opened || (expected && !isSameRegularFileIdentity(expected, opened))) return null;
		const contents = await handle.readFile({ encoding: "utf8" });
		if (!expected) return contents;
		const current = regularFileIdentity(await fs.lstat(target));
		const reread = regularFileIdentity(await handle.stat());
		return current && reread && isSameRegularFileIdentity(expected, current) && isSameRegularFileIdentity(expected, reread) ? contents : null;
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

export async function readBundleManifest(root = bundleDir): Promise<string | null> {
	return readRegularFile(path.join(root, BUNDLE_MANIFEST_NAME));
}

export async function validateInstalledBundle(root = bundleDir): Promise<string | null> {
	const files = renderSdkSkillFiles();
	return validateBundleManifest(await readBundleManifest(root), bundleContentFiles(files));
}

/**
 * Keeps the static prompts/operate.md allowlist blocks in sync with the
 * ALLOWED_CONTROLS / ALLOWED_GLOBALS constants the templates embed. The prompt
 * is the authored document; this validator is the drift gate that proves the
 * generated bundle and the templates still describe the same allowlist.
 */
export function validatePromptAllowlistConsistency(): string | null {
	const controlsBlock = `## Allowed per-session controls\n\n${ALLOWED_CONTROLS.map(operation => `- \`${operation}\``).join("\n")}\n`;
	const globalsBlock = `## Allowed lifecycle operations\n\n${ALLOWED_GLOBALS.map(operation => `- \`${operation}\``).join("\n")}\n`;
	if (!operatePrompt.includes(controlsBlock)) {
		return "prompt drift: static scripts/gjc-sdk-skills/prompts/operate.md per-session controls do not match ALLOWED_CONTROLS";
	}
	if (!operatePrompt.includes(globalsBlock)) {
		return "prompt drift: static scripts/gjc-sdk-skills/prompts/operate.md lifecycle operations do not match ALLOWED_GLOBALS";
	}
	return null;
}

function typeScriptTemplate(): string {
	return `#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

// Trusted-local procedural policy only. The Broker and SessionRouter retain session lifecycle and attachment authority.

const CORE_QUERIES = [
	"session.metadata",
	"context.get",
	"goal.list/get",
	"todo.list",
	"workflow.gates.list",
	"session.stats",
] as const;

const ALLOWED_CONTROLS: ReadonlySet<string> = new Set(${JSON.stringify(ALLOWED_CONTROLS)});
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;
const ALLOWED_ARGUMENTS = new Set(["--repo", "--session-id", "--mode", "--operation", "--input"]);

type Arguments = {
	repo: string;
	sessionId: string;
	mode: "inspect" | "control";
	operation?: string;
	input: Record<string, unknown>;
};

function parseArgs(argv: string[]): Arguments {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!ALLOWED_ARGUMENTS.has(token) || values.has(token)) throw new Error("invalid_argument");
		const value = argv[++index];
		if (!value) throw new Error("missing_argument_value");
		values.set(token, value);
	}
	const repo = values.get("--repo");
	const sessionId = values.get("--session-id");
	if (!repo) throw new Error("missing_repo");
	if (!sessionId) throw new Error("missing_session_id");
	const mode = values.get("--mode") ?? "inspect";
	if (mode !== "inspect" && mode !== "control") throw new Error("invalid_mode");
	let input: Record<string, unknown> = {};
	const rawInput = values.get("--input");
	if (rawInput) {
		const parsed: unknown = JSON.parse(rawInput);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_input");
		input = parsed as Record<string, unknown>;
	}
	if (hasSecretField(input)) throw new Error("secret_input_forbidden");
	return { repo, sessionId, mode, operation: values.get("--operation"), input };
}

function hasSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value as Record<string, unknown>).some(([key, nested]) => SECRET_FIELD.test(key) || hasSecretField(nested));
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			SECRET_FIELD.test(key) ? "[REDACTED]" : redact(item),
		]),
	);
}

function parseCliJson(stdout: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("invalid_cli_response");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_cli_response");
	return parsed as Record<string, unknown>;
}

async function runGjcSession(repo: string, arguments_: readonly string[]): Promise<Record<string, unknown>> {
	const child = Bun.spawn(["gjc", "sdk", "session", ...arguments_], {
		cwd: repo,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error("broker_request_failed");
	return parseCliJson(stdout);
}

async function inspect(repo: string, sessionId: string): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	for (const query of CORE_QUERIES) {
		try {
			const response = await runGjcSession(repo, ["raw", "query", sessionId, "--query", query]);
			if (response.ok === false) throw new Error("query_unavailable");
			snapshot[query] = { status: "confirmed", source: query, value: redact(response) };
		} catch {
			snapshot[query] = { status: "unavailable", source: query };
		}
	}
	return snapshot;
}

async function requireApproval(sessionId: string, operation: string, input: Record<string, unknown>): Promise<void> {
	const digest = createHash("sha256").update(JSON.stringify({ sessionId, operation, input })).digest("hex").slice(0, 16);
	const challenge = \`APPROVE \${sessionId} \${operation} \${digest} \${randomBytes(8).toString("hex")}\`;
	const reader = createInterface({ input: process.stdin, output: process.stderr });
	try {
		if ((await reader.question(\`Approval required: \${challenge}\\nType the exact challenge: \`)).trim() !== challenge)
			throw new Error("human_approval_required");
	} finally { reader.close(); }
}

async function raw(repo: string, args: string[]): Promise<unknown> {
	const process = Bun.spawn(["gjc", "sdk", "session", "raw", ...args, "--repo", repo], { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(process.stdout).text();
	if ((await process.exited) !== 0) throw new Error("broker_dispatch_failed");
	return JSON.parse(output) as unknown;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "inspect") {
		const result = await inspect(args.repo, args.sessionId);
		process.stdout.write(JSON.stringify(redact({ sessionId: args.sessionId, result }), null, 2) + "\\n");
		return;
	}
	if (!args.operation || !ALLOWED_CONTROLS.has(args.operation)) throw new Error("operation_not_allowed");
	const input = args.operation === "workflow.gate_answer" ? { ...args.input, expectedSessionId: args.sessionId } : args.input;
	await requireApproval(args.sessionId, args.operation, input);
	const result = await runGjcSession(args.repo, [
		"raw",
		"control",
		args.sessionId,
		"--op",
		args.operation,
		"--json-input",
		JSON.stringify(input),
		"--confirm",
	]);
	if (result.ok === false) throw new Error("control_failed");
	process.stdout.write(JSON.stringify(redact({ sessionId: args.sessionId, result }), null, 2) + "\\n");
}

main().catch(() => { process.stderr.write("GJC SDK request failed safely.\\n"); process.exitCode = 1; });
`;
}

function pythonTemplate(): string {
	return `#!/usr/bin/env python3

from __future__ import annotations

# Trusted-local procedural policy only. The Broker and SessionRouter retain session lifecycle and attachment authority.

import argparse
import hashlib
import json
import re
import secrets
import subprocess
import sys
from typing import Any, NoReturn

CORE_QUERIES = (
    "session.metadata",
    "context.get",
    "goal.list/get",
    "todo.list",
    "workflow.gates.list",
    "session.stats",
)
ALLOWED_CONTROLS = ${JSON.stringify(ALLOWED_CONTROLS).replaceAll('"', "'")}
SECRET_FIELD = re.compile(r"(?:secret|token|password|credential|authorization|api[_-]?key)", re.IGNORECASE)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise ValueError("invalid_argument")


def parse_args() -> argparse.Namespace:
    parser = SafeArgumentParser(description="Trusted local broker-bound GJC session template", allow_abbrev=False)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--mode", choices=("inspect", "control"), default="inspect")
    parser.add_argument("--operation")
    parser.add_argument("--input", default="{}")
    return parser.parse_args()


def has_secret_field(value: Any) -> bool:
    if isinstance(value, list):
        return any(has_secret_field(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(SECRET_FIELD.search(key) or has_secret_field(item) for key, item in value.items())


def redact(value: Any) -> Any:
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SECRET_FIELD.search(key) else redact(item)
            for key, item in value.items()
        }
    return value


def run_gjc_session(repo: str, arguments: list[str]) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            ["gjc", "sdk", "session", *arguments],
            cwd=repo,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        raise ValueError("broker_request_failed") from None
    if completed.returncode != 0:
        raise ValueError("broker_request_failed")
    try:
        response: Any = json.loads(completed.stdout)
    except json.JSONDecodeError:
        raise ValueError("invalid_cli_response") from None
    if not isinstance(response, dict):
        raise ValueError("invalid_cli_response")
    return response


def inspect(repo: str, session_id: str) -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for query in CORE_QUERIES:
        try:
            response = run_gjc_session(repo, ["raw", "query", session_id, "--query", query])
            if response.get("ok") is False:
                raise ValueError("query_unavailable")
            snapshot[query] = {"status": "confirmed", "source": query, "value": redact(response)}
        except Exception:
            snapshot[query] = {"status": "unavailable", "source": query}
    return snapshot


def require_approval(session_id: str, operation: str, operation_input: dict[str, Any]) -> None:
    payload = json.dumps(
        {"sessionId": session_id, "operation": operation, "input": operation_input},
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    challenge = f"APPROVE {session_id} {operation} {digest} {secrets.token_hex(8)}"
    print(f"Approval required: {challenge}\\nType the exact challenge: ", file=sys.stderr, end="", flush=True)
    answer = sys.stdin.readline()
    if answer.strip() != challenge:
        raise ValueError("human_approval_required")


def main() -> None:
    args = parse_args()
    operation_input = json.loads(args.input)
    if not isinstance(operation_input, dict):
        raise ValueError("input must be an object")
    if has_secret_field(operation_input):
        raise ValueError("secret_input_forbidden")
    if args.mode == "inspect":
        result = inspect(args.repo, args.session_id)
        print(json.dumps(redact({"sessionId": args.session_id, "result": result}), indent=2))
        return
    operation = args.operation
    if operation is None or operation not in ALLOWED_CONTROLS:
        raise ValueError("operation_not_allowed")
    if operation == "workflow.gate_answer":
        operation_input = {**operation_input, "expectedSessionId": args.session_id}
    require_approval(args.session_id, operation, operation_input)
    result = run_gjc_session(
        args.repo,
        [
            "raw",
            "control",
            args.session_id,
            "--op",
            operation,
            "--json-input",
            json.dumps(operation_input, separators=(",", ":")),
            "--confirm",
        ],
    )
    if result.get("ok") is False:
        raise ValueError("control_failed")
    print(json.dumps(redact({"sessionId": args.session_id, "result": result}), indent=2))


try:
    main()
except Exception:
    print("GJC SDK request failed safely.", file=sys.stderr)
    raise SystemExit(1)
`;
}

export function renderSdkSkillFiles(): Map<string, string> {
	const files = new Map<string, string>([
		[path.join("gjc-sdk-discover", "SKILL.md"), discoverPrompt],
		[path.join("gjc-sdk-operate", "SKILL.md"), operatePrompt],
		[path.join("gjc-sdk-author", "SKILL.md"), authorPrompt],
		[path.join("gjc-sdk-author", "templates", "direct-sdk.ts"), typeScriptTemplate()],
		[path.join("gjc-sdk-author", "templates", "direct-sdk.py"), pythonTemplate()],
	]);
	files.set(BUNDLE_MANIFEST_NAME, manifestFile(files));
	return files;
}

async function listFiles(dir: string, rel = ""): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const entryRel = path.join(rel, entry.name);
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) files.push(...(await listFiles(entryPath, entryRel)));
			else files.push(entryRel);
		}
		return files;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

export async function findUnexpectedSdkSkillFiles(files: ReadonlyMap<string, string>, root = bundleDir): Promise<string[]> {
	const expected = new Set(files.keys());
	return (await listFiles(root)).filter(rel => !expected.has(rel)).sort();
}

export async function checkSdkSkillFiles(files: ReadonlyMap<string, string>, root = bundleDir, report = true): Promise<number> {
	const problems: string[] = [];
	// Fail closed on the versioned contract first: an unsupported or missing
	// format version means the layout is unknown, so content-level drift checks
	// must not run against it.
	const manifestProblem = validateBundleManifest(await readBundleManifest(root), bundleContentFiles(files));
	if (manifestProblem !== null) problems.push(manifestProblem);
	const allowlistProblem = validatePromptAllowlistConsistency();
	if (allowlistProblem !== null) problems.push(allowlistProblem);
	if (problems.length === 0) {
		for (const [rel, content] of files) {
			const target = path.join(root, rel);
			const actual = await readRegularFile(target);
			if (actual === null) problems.push(`missing: sdk-skills/${rel}`);
			else if (actual !== content) problems.push(`drift: sdk-skills/${rel}`);
		}
		for (const rel of await findUnexpectedSdkSkillFiles(files, root)) problems.push(`unexpected: sdk-skills/${rel}`);
	}
	if (problems.length > 0) {
		if (report) {
			for (const problem of problems) process.stderr.write(`${problem}\n`);
			process.stderr.write("SDK skill bundle drift detected. Run `bun run generate-sdk-skills`.\n");
		}
		return 1;
	}
	if (report) process.stdout.write(`SDK skill bundle is in sync (${files.size} file(s)).\n`);
	return 0;
}

async function writeFiles(files: ReadonlyMap<string, string>): Promise<void> {
	await fs.rm(bundleDir, { recursive: true, force: true });
	for (const [rel, content] of files) {
		const target = path.join(bundleDir, rel);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, content);
	}
	process.stdout.write(`Generated ${files.size} SDK skill file(s) under sdk-skills/\n`);
}

async function runSelfTest(): Promise<void> {
	const files = renderSdkSkillFiles();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-skills-self-test-"));
	try {
		for (const [rel, content] of files) {
			const target = path.join(root, rel);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await Bun.write(target, content);
		}
		const stale = path.join(root, "gjc-sdk-author", "stale.md");
		await Bun.write(stale, "stale\n");
		if ((await checkSdkSkillFiles(files, root, false)) !== 1 || !(await findUnexpectedSdkSkillFiles(files, root)).includes(path.join("gjc-sdk-author", "stale.md")))
			throw new Error("SDK skill file-set check did not reject an unexpected file");
		process.stdout.write("SDK skill file-set self-test passed.\n");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const files = renderSdkSkillFiles();
	if (process.argv.includes("--self-test")) await runSelfTest();
	else if (process.argv.includes("--check")) process.exitCode = await checkSdkSkillFiles(files);
	else await writeFiles(files);
}
