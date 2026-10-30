import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@gajae-code/ai/core";
import { resolveGjcCommand } from "../task/gjc-command";
import { shortenPath } from "../tools/render-utils";

export const CONTRIBUTION_PREP_SCHEMA_VERSION = 1;

const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_TEXT_CHARS = 12000;
const MAX_GIT_OUTPUT_CHARS = 60000;
const MAX_REDACTION_INPUT_CHARS = 1_000_000;
// Keep whole Git captures within the redactor's input budget; discard an overrun
// instead of emitting a prefix.
const MAX_GIT_RAW_OUTPUT_BYTES = MAX_REDACTION_INPUT_CHARS;
const MAX_JSON_TOKENS = 20_000;
const MAX_JSON_REPLACEMENTS = 10_000;

export interface ContributionPrepArtifact {
	path: string;
	description: string;
}

export interface ContributionPrepManifest {
	schema_version: number;
	source_session_id: string;
	created_at: string;
	cwd: string;
	git_head: string | null;
	changed_files: string[];
	artifacts: ContributionPrepArtifact[];
	redactions: string[];
	recommended_output: string[];
	worker_prompt_path: string;
}

export interface ContributionPrepResult {
	manifestPath: string;
	workerPromptPath: string;
	artifactDir: string;
	changedFiles: string[];
	spawned: boolean;
}

export interface ContributionPrepOptions {
	customInstructions?: string;
	spawnWorker?: boolean;
	artifactRoot?: string;
	now?: Date;
	spawn?: (args: string[], cwd: string, shell: boolean) => Promise<void>;
}

export interface ContributionPrepContext {
	sessionId: string;
	cwd: string;
	sessionFile?: string;
	messages: AgentMessage[];
	customInstructions?: string;
	now?: Date;
}

interface RedactionState {
	labels: Set<string>;
}

function limitText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function replaceRegex(text: string, regex: RegExp, replacement: string, state: RedactionState, label: string): string {
	if (!regex.test(text)) return text;
	state.labels.add(label);
	regex.lastIndex = 0;
	return text.replace(regex, replacement);
}

function redactAwsAccessKeyIds(text: string, state: RedactionState): string {
	return replaceRegex(
		text,
		/(^|[^0-9A-Za-z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/g,
		"$1[REDACTED_AWS_KEY_ID]",
		state,
		"aws_keys",
	);
}

function isAwsSecretField(value: string): boolean {
	const normalized = value.toLowerCase().replaceAll(/[_-]/g, "");
	return (
		normalized === "secretaccesskey" ||
		normalized === "sessiontoken" ||
		normalized === "awssecretaccesskey" ||
		normalized === "awssessiontoken" ||
		normalized === "xamzsecuritytoken"
	);
}

function redactAwsLabeledValues(text: string, state: RedactionState): string {
	let redacted = redactAwsAccessKeyIds(text, state);
	redacted = replaceRegex(
		redacted,
		// STS XML responses are commonly pretty-printed, so the value sits on its own
		// line between the tags. `[^<]` still refuses to cross into another element,
		// while the call-wide input bound caps work without imposing a credential-size
		// assumption. The lower bound leaves empty or whitespace-only bodies alone.
		/(<((?:[A-Za-z_][\w.-]*:)?(?:SecretAccessKey|SessionToken))>)[^<]{8,1000000}(<\/\2>)/gi,
		"$1[REDACTED_SECRET]$3",
		state,
		"aws_keys",
	);
	redacted = replaceRegex(
		redacted,
		/(^|[^A-Za-z0-9_-])(["']?(?:(?:aws[_-]?)?secret[_-]?access[_-]?key|(?:aws[_-]?)?session[_-]?token|x[_-]?amz[_-]?security[_-]?token)["']?\s*[=:]\s*)(\$?)(["'`])([^"'`\r\n]{8,})\4/gi,
		"$1$2$3$4[REDACTED_SECRET]$4",
		state,
		"aws_keys",
	);
	return replaceRegex(
		redacted,
		/(^|[^A-Za-z0-9_-])(["']?(?:(?:aws[_-]?)?secret[_-]?access[_-]?key|(?:aws[_-]?)?session[_-]?token|x[_-]?amz[_-]?security[_-]?token)["']?\s*[=:]\s*)[^\s"'`,;{}[\]()&<>#]{8,}/gi,
		"$1$2[REDACTED_SECRET]",
		state,
		"aws_keys",
	);
}

function redactAwsJsonStrings(text: string, state: RedactionState, depth = 0): string {
	const tokens = [...text.matchAll(/"(?:\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})|[^"\\\r\n])*"/g)].map(match => ({
		start: match.index,
		end: match.index + match[0].length,
		raw: match[0],
	}));
	if (tokens.length > MAX_JSON_TOKENS) {
		state.labels.add("oversized_content");
		return "[REDACTED_OVERSIZED_CONTENT]";
	}
	const replacements = new Map<number, { end: number; value: string }>();

	for (const [index, token] of tokens.entries()) {
		let decoded: string;
		try {
			decoded = JSON.parse(token.raw) as string;
		} catch {
			continue;
		}

		if (isAwsSecretField(decoded)) {
			const separator = /^\s*:\s*/.exec(text.slice(token.end));
			const valueToken = tokens[index + 1];
			if (separator && valueToken?.start === token.end + separator[0].length) {
				let value: string;
				try {
					value = JSON.parse(valueToken.raw) as string;
				} catch {
					value = "";
				}
				if (value.length >= 8)
					replacements.set(valueToken.start, { end: valueToken.end, value: JSON.stringify("[REDACTED_SECRET]") });
			}
		}

		const nestedRedacted = depth >= 3 ? "[REDACTED_NESTED_CONTENT]" : redactAwsJsonStrings(decoded, state, depth + 1);
		const redacted = redactAwsLabeledValues(nestedRedacted, state);
		if (redacted !== decoded && !replacements.has(token.start)) {
			replacements.set(token.start, { end: token.end, value: JSON.stringify(redacted) });
		}
	}

	if (replacements.size === 0) return text;
	if (replacements.size > MAX_JSON_REPLACEMENTS) {
		state.labels.add("oversized_content");
		return "[REDACTED_OVERSIZED_CONTENT]";
	}
	state.labels.add("aws_keys");
	const chunks: string[] = [];
	let cursor = 0;
	for (const [start, replacement] of [...replacements.entries()].sort(([left], [right]) => left - right)) {
		chunks.push(text.slice(cursor, start), replacement.value);
		cursor = replacement.end;
	}
	chunks.push(text.slice(cursor));
	return chunks.join("");
}

function assertSafeArtifactPath(artifactDir: string): void {
	const state: RedactionState = { labels: new Set() };
	redactContributionPrepText(artifactDir, path.join(artifactDir, "__gjc_path_probe__"), state);
	if (["tokens", "aws_keys", "provider_keys", "auth_headers", "cookies"].some(label => state.labels.has(label))) {
		throw new Error("Contribution prep artifact path contains credential-like material.");
	}
}

export function redactContributionPrepText(
	text: string,
	cwd: string,
	state: RedactionState = { labels: new Set() },
): string {
	if (text.length > MAX_REDACTION_INPUT_CHARS) {
		state.labels.add("oversized_content");
		return "[REDACTED_OVERSIZED_CONTENT]";
	}
	let redacted = redactAwsJsonStrings(text, state);
	redacted = redactAwsLabeledValues(redacted, state);
	redacted = replaceRegex(
		redacted,
		/\b(?:sk|pk|rk|xox[baprs])-[-_A-Za-z0-9]{12,}\b/g,
		"[REDACTED_TOKEN]",
		state,
		"tokens",
	);
	redacted = replaceRegex(
		redacted,
		/\b(?:gh[opsur]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
		"[REDACTED_TOKEN]",
		state,
		"tokens",
	);
	redacted = replaceRegex(
		redacted,
		/\b((?:ANTHROPIC|OPENAI|GITHUB|GOOGLE|GEMINI|KAGI|TAVILY|EXA|PERPLEXITY|ZAI|KIMI|BRAVE|SEARXNG|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|COOKIE|PASSWORD))\s*=\s*[^\s\n]+/gi,
		"$1=[REDACTED_SECRET]",
		state,
		"provider_keys",
	);
	redacted = replaceRegex(
		redacted,
		/\b(Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token)\s+[^\s\n]+/gi,
		"$1: [REDACTED_AUTH_HEADER]",
		state,
		"auth_headers",
	);
	redacted = replaceRegex(redacted, /\b(Cookie|Set-Cookie)\s*:\s*[^\n]+/gi, "$1: [REDACTED_COOKIE]", state, "cookies");
	redacted = replaceRegex(
		redacted,
		/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})[^\s)>'"]*/gi,
		"[REDACTED_PRIVATE_ENDPOINT]",
		state,
		"private_endpoints",
	);
	const home = os.homedir();
	if (home && redacted.includes(home)) {
		state.labels.add("home_paths");
		redacted = redacted.split(home).join("~");
	}
	const normalizedCwd = path.resolve(cwd);
	if (normalizedCwd && redacted.includes(normalizedCwd)) {
		state.labels.add("cwd_paths");
		redacted = redacted.split(normalizedCwd).join(shortenPath(normalizedCwd));
	}
	return redacted;
}

function contentText(content: UserMessage["content"] | AssistantMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map(part => {
			if (part.type === "text") return part.text;
			if (part.type === "toolCall") return `[tool call: ${part.name}] ${JSON.stringify(part.arguments)}`;
			if (part.type === "image") return "[image]";
			return `[${part.type}]`;
		})
		.join("\n");
}

function formatMessage(message: AgentMessage): string {
	if (message.role === "user" || message.role === "assistant") {
		return `## ${message.role}\n\n${contentText(message.content)}\n`;
	}
	if (message.role === "toolResult") {
		const tool = message as ToolResultMessage;
		return `## toolResult: ${tool.toolName}\n\n${typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content)}\n`;
	}
	return `## ${message.role}\n\n${JSON.stringify(message)}\n`;
}

interface BoundedGitOutput {
	text: string;
	oversized: boolean;
}

async function readBoundedGitOutput(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedGitOutput> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) return { text: "", oversized: true };
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(bytes), oversized: false };
}

async function gitOutput(
	cwd: string,
	args: string[],
	state: RedactionState,
	maxChars = MAX_GIT_OUTPUT_CHARS,
): Promise<string> {
	try {
		const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const stop = (): void => {
			try {
				proc.kill();
			} catch {
				// The process already exited.
			}
		};
		try {
			const output = await readBoundedGitOutput(proc.stdout, MAX_GIT_RAW_OUTPUT_BYTES);
			if (output.oversized) {
				stop();
				await proc.exited;
				state.labels.add("oversized_content");
				return "[REDACTED_OVERSIZED_CONTENT]";
			}
			if ((await proc.exited) !== 0) return "";
			return limitText(redactContributionPrepText(output.text.trim(), cwd, state), maxChars);
		} catch {
			stop();
			await proc.exited;
			return "";
		}
	} catch {
		return "";
	}
}

async function changedFiles(cwd: string, state: RedactionState): Promise<string[]> {
	const output = await gitOutput(cwd, ["status", "--short"], state);
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => line.replace(/^..\s+/, ""));
}

async function writeArtifact(
	dir: string,
	name: string,
	description: string,
	text: string,
): Promise<ContributionPrepArtifact> {
	const filePath = path.join(dir, name);
	await Bun.write(filePath, `${text.trimEnd()}\n`);
	return { path: filePath, description };
}

export function buildContributionPrepWorkerPrompt(manifestPath: string): string {
	const manifestName = path.basename(manifestPath);
	return [
		"Prepare a maintainer-friendly contribution draft from the redacted context dump.",
		"Read the manifest beside this worker prompt and its relative artifact file pointers. Do not assume transcript context was inlined here.",
		`Manifest: ${manifestName}`,
		"Produce structured markdown with: title, problem summary, reproduction/context, proposed fix or implementation plan, affected files, tests to run, and uncertainty/remaining risks.",
		"Do not create GitHub issues, open PRs, push branches, or perform remote writes unless the user explicitly confirms that action in this fresh session.",
	].join("\n");
}

function safeWorkspaceLabel(cwd: string): string {
	const resolved = path.resolve(cwd);
	const home = os.homedir();
	if (home && (resolved === home || resolved.startsWith(`${home}${path.sep}`))) return shortenPath(resolved);
	return path.basename(resolved) || ".";
}

export async function prepareContributionPrep(
	context: ContributionPrepContext,
	options: ContributionPrepOptions = {},
): Promise<ContributionPrepResult> {
	const createdAt = (options.now ?? context.now ?? new Date()).toISOString();
	const safeTimestamp = createdAt.replace(/[:.]/g, "-");
	const artifactDir = path.join(
		options.artifactRoot ?? path.join(context.cwd, ".gjc", "contribution-prep"),
		safeTimestamp,
	);
	assertSafeArtifactPath(artifactDir);
	await fs.mkdir(artifactDir, { recursive: true });

	const redactions: RedactionState = { labels: new Set() };
	const recentMessages = context.messages.slice(-MAX_TRANSCRIPT_MESSAGES);
	const artifacts: ContributionPrepArtifact[] = [];
	const redact = (text: string) => redactContributionPrepText(text, context.cwd, redactions);
	const workspaceLabel = safeWorkspaceLabel(context.cwd);

	artifacts.push(
		await writeArtifact(
			artifactDir,
			"transcript.md",
			"Redacted recent transcript window",
			redact(recentMessages.map(formatMessage).join("\n---\n")),
		),
	);
	artifacts.push(
		await writeArtifact(
			artifactDir,
			"summary.md",
			"Current session summary and operator instructions",
			redact(
				[
					`# Contribution prep context`,
					`Source session: ${context.sessionId}`,
					`Session file: ${context.sessionFile ? path.basename(context.sessionFile) : "(none)"}`,
					`Working directory: ${workspaceLabel}`,
					options.customInstructions || context.customInstructions
						? `Custom instructions: ${options.customInstructions ?? context.customInstructions}`
						: "Custom instructions: (none)",
				].join("\n"),
			),
		),
	);

	const gitHead = (await gitOutput(context.cwd, ["rev-parse", "HEAD"], redactions)) || null;
	const files = await changedFiles(context.cwd, redactions);
	artifacts.push(
		await writeArtifact(artifactDir, "changed-files.txt", "Changed files from git status", redact(files.join("\n"))),
	);
	artifacts.push(
		await writeArtifact(
			artifactDir,
			"git-diff.patch",
			"Bounded redacted git diff",
			await gitOutput(context.cwd, ["diff", "--no-ext-diff"], redactions),
		),
	);
	artifacts.push(
		await writeArtifact(
			artifactDir,
			"environment.md",
			"Redacted environment and reproduction metadata",
			redact(
				[
					`cwd: ${workspaceLabel}`,
					`git_head: ${gitHead ?? "unknown"}`,
					`platform: ${process.platform}`,
					`arch: ${process.arch}`,
					`bun: ${Bun.version}`,
				].join("\n"),
			),
		),
	);

	const manifestPath = path.join(artifactDir, "manifest.json");
	const workerPromptPath = path.join(artifactDir, "worker-prompt.md");
	await Bun.write(workerPromptPath, `${buildContributionPrepWorkerPrompt(manifestPath)}\n`);
	const manifestArtifacts = artifacts.map(artifact => ({ ...artifact, path: path.basename(artifact.path) }));

	const manifest: ContributionPrepManifest = {
		schema_version: CONTRIBUTION_PREP_SCHEMA_VERSION,
		source_session_id: redact(context.sessionId),
		created_at: createdAt,
		cwd: redact(workspaceLabel),
		git_head: gitHead,
		changed_files: files.map(redact),
		artifacts: manifestArtifacts,
		redactions: [...redactions.labels].sort(),
		recommended_output: [
			"title",
			"problem summary",
			"reproduction/context",
			"proposed fix or implementation plan",
			"affected files",
			"tests to run",
			"uncertainty / remaining risks",
		],
		worker_prompt_path: path.basename(workerPromptPath),
	};
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	let spawned = false;
	if (options.spawnWorker) {
		const spawn =
			options.spawn ??
			(async (args, cwd, shell) => {
				if (shell) {
					Bun.spawn({
						cmd: args,
						cwd,
						stdout: "inherit",
						stderr: "inherit",
						stdin: "inherit",
						windowsVerbatimArguments: true,
					});
					return;
				}
				Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
			});
		const command = resolveGjcCommand();
		await spawn(
			[command.cmd, ...command.args, "--no-skills", "--", `@${path.basename(workerPromptPath)}`],
			artifactDir,
			command.shell,
		);
		spawned = true;
	}

	return { manifestPath, workerPromptPath, artifactDir, changedFiles: files, spawned };
}
