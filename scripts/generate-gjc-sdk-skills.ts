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
import { lstat, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { SdkClient, listSdkSessionEndpoints, type SdkSessionEndpoint } from "@gajae-code/coding-agent/sdk";

// Trusted-local procedural policy only; this template does not isolate a modified process from endpoint authority.

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
	sessionId?: string;
	mode: "inspect" | "control";
	operation?: string;
	input: Record<string, unknown>;
};

function parseArgs(argv: string[]): Arguments {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!ALLOWED_ARGUMENTS.has(token)) throw new Error("invalid_argument");
		const value = argv[++index];
		if (!value) throw new Error("missing_argument_value");
		values.set(token, value);
	}
	const repo = values.get("--repo");
	if (!repo) throw new Error("missing_repo");
	const mode = values.get("--mode") ?? "inspect";
	if (mode !== "inspect" && mode !== "control") throw new Error("invalid_mode");
	let input: Record<string, unknown> = {};
	const rawInput = values.get("--input");
	if (rawInput) {
		const parsed: unknown = JSON.parse(rawInput);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_input");
		input = parsed as Record<string, unknown>;
	}
	return {
		repo,
		sessionId: values.get("--session-id"),
		mode,
		operation: values.get("--operation"),
		input,
	};
}

function endpointState(endpoint: SdkSessionEndpoint): "live" | "stale" | "dead" | "unknown" {
	if (endpoint.stale) return "stale";
	if (!endpoint.pid) return "unknown";
	try {
		process.kill(endpoint.pid, 0);
		return "live";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM") return "live";
		return code === "ESRCH" ? "dead" : "unknown";
	}
}

async function selectEndpoint(repo: string, sessionId?: string): Promise<SdkSessionEndpoint> {
	const discoveryDirectory = path.join(repo, ".gjc", "state", "sdk");
	const directoryStat = await lstat(discoveryDirectory).catch(() => undefined);
	if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
		throw new Error("unsafe_discovery_directory");
	const entries = await readdir(discoveryDirectory, { withFileTypes: true });
	if (entries.some(entry => entry.isSymbolicLink())) throw new Error("unsafe_discovery_record");
	if (entries.some(entry => entry.name.endsWith(".json") && !entry.isFile())) throw new Error("unsafe_discovery_record");
	const discovered = await listSdkSessionEndpoints(repo);
	if (discovered.warnings.length > 0) throw new Error("discovery_warning");
	for (const endpoint of discovered.endpoints) {
		const endpointStat = await lstat(endpoint.path).catch(() => undefined);
		if (!endpointStat || endpointStat.isSymbolicLink() || !endpointStat.isFile())
			throw new Error("unsafe_discovery_record");
		const record: unknown = JSON.parse(await readFile(endpoint.path, "utf8"));
		const embeddedSessionId =
			record && typeof record === "object" ? (record as { sessionId?: unknown }).sessionId : undefined;
		if (embeddedSessionId !== undefined && embeddedSessionId !== endpoint.sessionId)
			throw new Error("invalid_discovery_record");
	}
	const live = discovered.endpoints.filter(endpoint => endpointState(endpoint) === "live");
	if (sessionId) {
		const selected = discovered.endpoints.find(endpoint => endpoint.sessionId === sessionId);
		if (!selected) throw new Error("session_not_found");
		if (endpointState(selected) !== "live") throw new Error("session_not_live");
		return selected;
	}
	if (live.length !== 1) throw new Error(live.length === 0 ? "no_live_session" : "ambiguous_session");
	return live[0];
}

function sameEndpoint(left: SdkSessionEndpoint, right: SdkSessionEndpoint): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.url === right.url &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.stale === right.stale &&
		left.path === right.path
	);
}

function redact(value: unknown, endpointToken: string): unknown {
	if (typeof value === "string") return value.replaceAll(endpointToken, "[REDACTED]");
	if (Array.isArray(value)) return value.map(item => redact(item, endpointToken));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			SECRET_FIELD.test(key) ? "[REDACTED]" : redact(item, endpointToken),
		]),
	);
}

async function inspect(client: SdkClient, endpointToken: string): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	for (const query of CORE_QUERIES) {
		try {
			snapshot[query] = { status: "confirmed", source: query, value: redact(await client.query(query), endpointToken) };
		} catch {
			snapshot[query] = { status: "unavailable", source: query };
		}
	}
	return snapshot;
}

async function requireApproval(sessionId: string, operation: string, input: Record<string, unknown>): Promise<void> {
	const digest = createHash("sha256")
		.update(JSON.stringify({ sessionId, operation, input }))
		.digest("hex")
		.slice(0, 16);
	const challenge = \`APPROVE \${sessionId} \${operation} \${digest} \${randomBytes(8).toString("hex")}\`;
	const reader = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await reader.question(\`Approval required: \${challenge}\\nType the exact challenge: \`);
		if (answer.trim() !== challenge) throw new Error("human_approval_required");
	} finally {
		reader.close();
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	let endpoint = await selectEndpoint(args.repo, args.sessionId);
	if (args.mode === "control") {
		if (!args.operation || !ALLOWED_CONTROLS.has(args.operation)) throw new Error("operation_not_allowed");
		if (args.operation === "workflow.gate_answer") args.input.expectedSessionId = endpoint.sessionId;
		await requireApproval(endpoint.sessionId, args.operation, args.input);
		const revalidated = await selectEndpoint(args.repo, endpoint.sessionId);
		if (!sameEndpoint(endpoint, revalidated)) throw new Error("endpoint_changed");
		endpoint = revalidated;
	}
	const client = await SdkClient.connect(endpoint.url, endpoint.token);
	try {
		const result =
			args.mode === "inspect"
				? await inspect(client, endpoint.token)
				: await client.control(args.operation!, args.input, { confirm: true });
		process.stdout.write(JSON.stringify(redact({ sessionId: endpoint.sessionId, result }, endpoint.token), null, 2) + "\\n");
	} finally {
		await client.close();
	}
}

main().catch(() => {
	process.stderr.write("GJC SDK request failed safely.\\n");
	process.exitCode = 1;
});
`;
}

function pythonTemplate(): string {
	return `#!/usr/bin/env python3

from __future__ import annotations

# Trusted-local procedural policy only; this template does not isolate a modified process from endpoint authority.

import argparse
import asyncio
from dataclasses import asdict, is_dataclass
import hashlib
import json
from pathlib import Path
import re
import secrets
import sys
from typing import Any, NoReturn
import warnings

from gjc_sdk import Endpoint, SdkClient, read_session_endpoint, select_live_endpoint

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
    parser = SafeArgumentParser(description="Trusted local direct GJC SDK template", allow_abbrev=False)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--session-id")
    parser.add_argument("--mode", choices=("inspect", "control"), default="inspect")
    parser.add_argument("--operation")
    parser.add_argument("--input", default="{}")
    return parser.parse_args()


def redact(value: Any, endpoint_token: str) -> Any:
    if isinstance(value, str):
        return value.replace(endpoint_token, "[REDACTED]")
    if is_dataclass(value) and not isinstance(value, type):
        return redact(asdict(value), endpoint_token)
    if isinstance(value, list):
        return [redact(item, endpoint_token) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SECRET_FIELD.search(key) else redact(item, endpoint_token)
            for key, item in value.items()
        }
    return value


async def inspect(client: SdkClient, endpoint_token: str) -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for query in CORE_QUERIES:
        try:
            response = await client.query(query, {})
            if response.ok:
                snapshot[query] = {"status": "confirmed", "source": query, "value": redact(response, endpoint_token)}
            else:
                snapshot[query] = {"status": "unavailable", "source": query}
        except Exception:
            snapshot[query] = {"status": "unavailable", "source": query}
    return snapshot

def select_endpoint(repo: str, session_id: str | None) -> Endpoint:
    directory = Path(repo) / ".gjc" / "state" / "sdk"
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("unsafe_discovery_directory")
    paths = sorted(directory.glob("*.json"))
    if any(path.is_symlink() or not path.is_file() for path in paths):
        raise ValueError("unsafe_discovery_record")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        endpoints = []
        for path in paths:
            endpoint = read_session_endpoint(repo, path.stem)
            if endpoint is None or endpoint.session_id != path.stem:
                raise ValueError("invalid_discovery_record")
            endpoints.append(endpoint)
        if caught or len({endpoint.session_id for endpoint in endpoints}) != len(endpoints):
            raise ValueError("invalid_discovery_record")
    return select_live_endpoint(endpoints, session_id)

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


async def main() -> None:
    args = parse_args()
    operation_input = json.loads(args.input)
    if not isinstance(operation_input, dict):
        raise ValueError("input must be an object")
    endpoint = select_endpoint(args.repo, args.session_id)
    operation = args.operation
    if args.mode == "control":
        if operation is None or operation not in ALLOWED_CONTROLS:
            raise ValueError("operation_not_allowed")
        if operation == "workflow.gate_answer":
            operation_input["expectedSessionId"] = endpoint.session_id
        require_approval(endpoint.session_id, operation, operation_input)
        revalidated = select_endpoint(args.repo, endpoint.session_id)
        if revalidated != endpoint:
            raise ValueError("endpoint_changed")
        endpoint = revalidated
    client = await SdkClient.connect_ws(
        args.repo,
        endpoint.session_id,
        token=endpoint.token,
        url=endpoint.url,
    )
    try:
        result: object
        if args.mode == "inspect":
            result = await inspect(client, endpoint.token)
        else:
            assert operation is not None
            response = await client.control(operation, operation_input)
            if not response.ok:
                raise RuntimeError("control_failed")
            result = response
        print(json.dumps(redact({"sessionId": endpoint.session_id, "result": result}, endpoint.token), indent=2))
    finally:
        await client.close()


try:
    asyncio.run(main())
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
