#!/usr/bin/env bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const bundleDir = path.join(repoRoot, "sdk-skills");

const ALLOWED_CONTROLS = [
	"turn.prompt",
	"turn.steer",
	"turn.follow_up",
	"ask.answer",
	"workflow.gate_answer",
	"todo.replace",
	"session.switch",
	"session.rename",
] as const;

const ALLOWED_GLOBALS = ["session.create", "session.fork", "session.resume", "session.close"] as const;

function discoverSkill(): string {
	return `---
name: gjc-sdk-discover
description: Discover and inspect trusted local GJC sessions through direct SDK v3 endpoints.
---

# GJC SDK session discovery

Use this skill when an external agent needs to find or inspect local GJC sessions without terminal scraping, MCP, or coordinator delegation.

## Required behavior

1. Resolve the repository root explicitly.
2. Read the local SDK discovery records under \`<repo>/.gjc/state/sdk/\` through the maintained SDK discovery API.
3. Select an exact session ID. Session omission is allowed only when exactly one live endpoint exists.
4. Fail closed for missing, malformed, stale, dead, unknown, symlinked, or ambiguous discovery.
5. Never print, persist, return, or place the endpoint token in logs, errors, source, config, environment examples, or shell history.
6. Close every SDK client in a \`finally\` block.

## Core inspection recipe

Compose this pull-based view in order:

1. \`session.metadata\`
2. \`context.get\`
3. \`goal.list/get\`
4. \`todo.list\`
5. \`workflow.gates.list\`
6. \`session.stats\`

Fetch transcript pages and diffs only when the user's task requires them:

- \`transcript.list\` and \`transcript.body\`
- \`diff.list_files\`, \`diff.list_hunks\`, and \`diff.read_hunk\`

The reads are not an atomic snapshot. For every reported field, identify its source query and classify it as \`confirmed\`, \`inferred\`, \`stale\`, \`unavailable\`, or \`unknown\`. Preserve partial results when independent queries succeed; never invent a missing value.

## Direct client references

- TypeScript: \`@gajae-code/coding-agent/sdk\`
- Python: \`gjc_sdk\`
- Canonical templates: \`gjc-sdk-author/templates/direct-sdk.ts\` and \`direct-sdk.py\`
`;
}

function operateSkill(): string {
	return `---
name: gjc-sdk-operate
description: Operate trusted local GJC sessions through a reviewed direct-SDK allowlist with single-use human approval.
---

# GJC SDK approved operations

This skill is for trusted local scripts. It is a procedural safety policy, not a security boundary: a modified process that can read the endpoint token can call more of the SDK than this skill permits.

## Before every operation

1. Rediscover the exact target session and fail closed if it is missing, stale, dead, unknown, symlinked, or ambiguous.
2. Never print, persist, return, or embed endpoint credentials.
3. Validate the operation against the allowlist below. Do not expose arbitrary operation passthrough.
4. For every lifecycle operation, show the exact operation and session target to the human through the external host.
5. Obtain one explicit approval immediately before the call. Approval is single-use and becomes invalid if the operation, input, or target changes.
   The templates emit a nonce-bearing, input-bound \`APPROVE <session> <operation> <digest> <nonce>\` challenge and read the exact response once from the active process's standard input. Present it verbatim through the external host only after the human accepts that exact action.
6. On denial, cancellation, failed rediscovery, or changed target, send no SDK request.
7. Close the SDK client on success and failure.
8. Render only bounded, redacted error codes or generic failures; never forward raw SDK error text that may contain credentials.

## Allowed per-session controls

${ALLOWED_CONTROLS.map(operation => `- \`${operation}\``).join("\n")}

For \`workflow.gate_answer\`, use the durable workflow gate ID and pass \`expectedSessionId\`. Never use transient \`action_needed.id\` as durable authority.

## Allowed lifecycle operations

${ALLOWED_GLOBALS.map(operation => `- \`${operation}\``).join("\n")}

Use the existing daemon-owned SDK lifecycle surface or the pure-SDK \`gjc daemon session global\` command family as documented. Do not pretend lifecycle operations share the per-session endpoint or one idempotency model.

## Explicitly excluded

- \`session.delete\`
- managed bash operations
- configuration mutation
- authentication mutation
- permission-mode mutation
- tool activation mutation
- extension mutation
- session cwd mutation
- endpoint credential display
- arbitrary SDK operation names

The templates demonstrate one inspection flow and one allowlisted per-session control flow. Keep broader lifecycle orchestration in reviewed scripts that follow the same approval and credential rules.
`;
}

function authorSkill(): string {
	return `---
name: gjc-sdk-author
description: Author trusted local TypeScript and Python scripts that use direct GJC SDK v3 endpoints safely.
---

# Author direct GJC SDK scripts

Start from the owned templates in this skill directory:

- \`templates/direct-sdk.ts\`
- \`templates/direct-sdk.py\`

## Authoring contract

- Use the maintained TypeScript or Python SDK client; do not reimplement the WebSocket protocol.
- Accept repository and session ID as non-secret inputs.
- Resolve endpoint credentials at runtime from the selected local session.
- Fail closed when discovery is missing, stale, dead, unknown, symlinked, or ambiguous.
- Never accept a token as the default CLI interface.
- Never print, serialize, persist, cache, or embed endpoint tokens.
- Keep query and control operation names on fixed allowlists.
- Require an immediately preceding, single-use human approval before mutation.
- Use the template's nonce-bearing operation/session/input-bound standard-input challenge; never replace it with a free boolean or reusable approval.
- Send no SDK request after denial or cancellation.
- Bind durable workflow controls to the expected session ID.
- Redact secret-shaped keys from all rendered results.
- Close clients in \`finally\` blocks.
- State that these are trusted local procedural controls, not capability isolation.

Generated user scripts belong in the user's workspace. Only the two canonical templates are owned by this clean-generated bundle.
`;
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
    answer = input(f"Approval required: {challenge}\\nType the exact challenge: ")
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
    print("GJC SDK request failed safely.", file=__import__("sys").stderr)
    raise SystemExit(1)
`;
}

export function renderSdkSkillFiles(): Map<string, string> {
	return new Map([
		[path.join("gjc-sdk-discover", "SKILL.md"), discoverSkill()],
		[path.join("gjc-sdk-operate", "SKILL.md"), operateSkill()],
		[path.join("gjc-sdk-author", "SKILL.md"), authorSkill()],
		[path.join("gjc-sdk-author", "templates", "direct-sdk.ts"), typeScriptTemplate()],
		[path.join("gjc-sdk-author", "templates", "direct-sdk.py"), pythonTemplate()],
	]);
}

function listFiles(dir: string, rel = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryRel = path.join(rel, entry.name);
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(entryPath, entryRel));
		else files.push(entryRel);
	}
	return files;
}

export function findUnexpectedSdkSkillFiles(files: ReadonlyMap<string, string>, root = bundleDir): string[] {
	const expected = new Set(files.keys());
	return listFiles(root).filter(rel => !expected.has(rel)).sort();
}

export function checkSdkSkillFiles(files: ReadonlyMap<string, string>, root = bundleDir, report = true): number {
	const problems: string[] = [];
	for (const [rel, content] of files) {
		const target = path.join(root, rel);
		let actual: string | null = null;
		try {
			const stat = fs.lstatSync(target);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				problems.push(`invalid: sdk-skills/${rel}`);
				continue;
			}
			actual = fs.readFileSync(target, "utf8");
		} catch {
			actual = null;
		}
		if (actual === null) problems.push(`missing: sdk-skills/${rel}`);
		else if (actual !== content) problems.push(`drift: sdk-skills/${rel}`);
	}
	for (const rel of findUnexpectedSdkSkillFiles(files, root)) problems.push(`unexpected: sdk-skills/${rel}`);
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

function writeFiles(files: ReadonlyMap<string, string>): void {
	fs.rmSync(bundleDir, { recursive: true, force: true });
	for (const [rel, content] of files) {
		const target = path.join(bundleDir, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	process.stdout.write(`Generated ${files.size} SDK skill file(s) under sdk-skills/\n`);
}

function runSelfTest(): void {
	const files = renderSdkSkillFiles();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-skills-self-test-"));
	try {
		for (const [rel, content] of files) {
			const target = path.join(root, rel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
		const stale = path.join(root, "gjc-sdk-author", "stale.md");
		fs.writeFileSync(stale, "stale\n");
		if (checkSdkSkillFiles(files, root, false) !== 1 || !findUnexpectedSdkSkillFiles(files, root).includes(path.join("gjc-sdk-author", "stale.md")))
			throw new Error("SDK skill file-set check did not reject an unexpected file");
		process.stdout.write("SDK skill file-set self-test passed.\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const files = renderSdkSkillFiles();
	if (process.argv.includes("--self-test")) runSelfTest();
	else if (process.argv.includes("--check")) process.exitCode = checkSdkSkillFiles(files);
	else writeFiles(files);
}
