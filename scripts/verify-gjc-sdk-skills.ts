#!/usr/bin/env bun

import * as path from "node:path";
import {
	BUNDLE_FORMAT_VERSION,
	BUNDLE_MANIFEST_NAME,
	findUnexpectedSdkSkillFiles,
	renderSdkSkillFiles,
	validateInstalledBundle,
	validatePromptAllowlistConsistency,
} from "./generate-gjc-sdk-skills";

interface GateResult {
	name: string;
	ok: boolean;
	detail: string;
}

const results: GateResult[] = [];
function gate(name: string, ok: boolean, detail: string): void {
	results.push({ name, ok, detail });
}

const files = renderSdkSkillFiles();
const discoverPath = path.join("gjc-sdk-discover", "SKILL.md");
const operatePath = path.join("gjc-sdk-operate", "SKILL.md");
const authorPath = path.join("gjc-sdk-author", "SKILL.md");
const typeScriptPath = path.join("gjc-sdk-author", "templates", "direct-sdk.ts");
const pythonPath = path.join("gjc-sdk-author", "templates", "direct-sdk.py");
const expectedPaths = [discoverPath, operatePath, authorPath, typeScriptPath, pythonPath, BUNDLE_MANIFEST_NAME].sort();
const actualPaths = [...files.keys()].sort();
const unexpectedFiles = await findUnexpectedSdkSkillFiles(files);
const manifestProblem = await validateInstalledBundle();

gate("exact six-file versioned bundle", JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), actualPaths.join(", "));
gate("no unexpected generated files", unexpectedFiles.length === 0, unexpectedFiles.join(", ") || "none");
gate(
	"versioned bundle manifest present and supported",
	manifestProblem === null,
	manifestProblem ?? `formatVersion ${BUNDLE_FORMAT_VERSION}`,
);
gate(
	"static prompt sources stay in sync with the generated allowlists",
	validatePromptAllowlistConsistency() === null,
	"scripts/gjc-sdk-skills/prompts/operate.md",
);

const discover = files.get(discoverPath) ?? "";
const operate = files.get(operatePath) ?? "";
const author = files.get(authorPath) ?? "";
const typeScript = files.get(typeScriptPath) ?? "";
const python = files.get(pythonPath) ?? "";

for (const [name, contents, expectedName] of [
	["discover", discover, "gjc-sdk-discover"],
	["operate", operate, "gjc-sdk-operate"],
	["author", author, "gjc-sdk-author"],
] as const) {
	gate(`${name} skill frontmatter`, contents.startsWith(`---\nname: ${expectedName}\n`), expectedName);
}

const coreQueries = [
	"session.metadata",
	"context.get",
	"goal.list/get",
	"todo.list",
	"workflow.gates.list",
	"session.stats",
] as const;
for (const query of coreQueries) {
	gate(
		`core query ${query}`,
		discover.includes(`\`${query}\``) && typeScript.includes(`"${query}"`) && python.includes(`"${query}"`),
		query,
	);
}

gate(
	"on-demand transcript and diff guidance",
	discover.includes("Fetch transcript pages and diffs only") && discover.includes("transcript.list") && discover.includes("diff.list_files"),
	"discovery drilldowns",
);
gate(
	"uncertainty labels",
	["confirmed", "inferred", "stale", "unavailable", "unknown"].every(label => discover.includes(`\`${label}\``)),
	"confirmed/inferred/stale/unavailable/unknown",
);

gate(
	"trusted-local disclaimer",
	operate.includes("procedural safety policy, not a security boundary") && author.includes("not capability isolation"),
	"procedural trust model",
);
gate(
	"single-use human approval",
	operate.includes("Approval is single-use") && operate.includes("send no SDK request") && author.includes("single-use human approval"),
	"approval contract",
);
gate(
	"excluded mutations documented",
	["session.delete", "managed bash", "configuration mutation", "authentication mutation", "permission-mode mutation", "tool activation mutation", "extension mutation", "session cwd mutation"].every(value => operate.includes(value)),
	"exclusion list",
);

gate(
	"templates are direct SDK clients",
	typeScript.includes('@gajae-code/coding-agent/sdk') && python.includes("from gjc_sdk import") && python.includes("SdkClient"),
	"maintained SDK imports",
);
gate(
	"templates require repository input",
	typeScript.includes('values.get("--repo")') && python.includes('parser.add_argument("--repo", required=True)'),
	"--repo",
);
gate(
	"templates require immediate nonce-bound approval",
	typeScript.includes("await requireApproval(endpoint.sessionId, args.operation, args.input)") &&
		python.includes("require_approval(endpoint.session_id, operation, operation_input)") &&
		typeScript.includes("randomBytes(8)") &&
		python.includes("secrets.token_hex(8)") &&
		typeScript.includes("Type the exact challenge") &&
		python.includes("Type the exact challenge") &&
		typeScript.includes("human_approval_required") &&
		python.includes("human_approval_required"),
	"single-process operation/session/input/nonce approval",
);
gate(
	"python approval challenge stays off stdout",
	python.includes("file=sys.stderr") && python.includes("sys.stdin.readline()"),
	"challenge on stderr, answer from stdin",
);
gate(
	"templates close clients",
	typeScript.includes("finally {\n\t\tawait client.close();") && python.includes("finally:\n        await client.close()"),
	"finally close",
);
gate(
	"templates redact secret-shaped fields and endpoint token values",
	typeScript.includes("SECRET_FIELD") &&
		python.includes("SECRET_FIELD") &&
		typeScript.includes('value.replaceAll(endpointToken, "[REDACTED]")') &&
		python.includes('value.replace(endpoint_token, "[REDACTED]")'),
	"field and value redaction",
);
gate(
	"templates omit token CLI arguments",
	!typeScript.includes('"--token"') && !python.includes('"--token"'),
	"no --token",
);

gate(
	"templates reject unsupported CLI arguments",
	typeScript.includes("ALLOWED_ARGUMENTS.has(token)") && python.includes("argparse.ArgumentParser"),
	"closed argument grammar",
);

gate(
	"no MCP or coordinator commands",
	![...files.values()].some(contents => /\bmcp-serve\b|\bcoordinator-mcp\b|\bmcp-serve coordinator\b/.test(contents)),
	"no MCP/coordinator command paths",
);
gate(
	"no arbitrary control passthrough",
	typeScript.includes("ALLOWED_CONTROLS.has") && python.includes("operation not in ALLOWED_CONTROLS"),
	"fixed operation allowlist",
);

const failed = results.filter(result => !result.ok);
for (const result of results) {
	process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}\n`);
}
if (failed.length > 0) {
	process.stderr.write(`SDK skill verification failed (${failed.length}/${results.length} gates).\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`SDK skill verification passed (${results.length} gates).\n`);
}
