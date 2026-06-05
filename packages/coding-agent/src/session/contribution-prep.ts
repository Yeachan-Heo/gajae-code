import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@gajae-code/ai";
import { $ } from "bun";
import { resolveGjcCommand } from "../task/gjc-command";
import { shortenPath } from "../tools/render-utils";

export const CONTRIBUTION_PREP_SCHEMA_VERSION = 1;

const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_TEXT_CHARS = 12000;
const MAX_GIT_OUTPUT_CHARS = 60000;

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

export function redactContributionPrepText(
	text: string,
	cwd: string,
	state: RedactionState = { labels: new Set() },
): string {
	let redacted = text;
	redacted = replaceRegex(
		redacted,
		/\b(?:sk|pk|rk|xox[baprs])-[-_A-Za-z0-9]{12,}\b/g,
		"[REDACTED_TOKEN]",
		state,
		"tokens",
	);
	redacted = replaceRegex(
		redacted,
		/\b(?:ghp_[A-Za-z0-9_]{12,}|gho_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
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

async function gitOutput(cwd: string, args: string[], maxChars = MAX_GIT_OUTPUT_CHARS): Promise<string> {
	try {
		const output = await $`git ${args}`.cwd(cwd).quiet().text();
		return limitText(output.trim(), maxChars);
	} catch {
		return "";
	}
}

async function changedFiles(cwd: string): Promise<string[]> {
	const output = await gitOutput(cwd, ["status", "--short"]);
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

export async function spawnContributionPrepWorker(args: string[], cwd: string, shell: boolean): Promise<void> {
	const child = shell
		? Bun.spawn({
				cmd: args,
				cwd,
				stdout: "inherit",
				stderr: "inherit",
				stdin: "inherit",
				windowsVerbatimArguments: true,
			})
		: Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`contribute-pr worker exited with code ${exitCode}`);
	}
}

export function buildContributionPrepWorkerPrompt(manifestPath: string): string {
	return [
		"Prepare a maintainer-friendly contribution draft from the redacted context dump.",
		"Read the manifest and referenced artifact file pointers. Do not assume transcript context was inlined here.",
		`Manifest: ${manifestPath}`,
		"Produce structured markdown with: title, problem summary, reproduction/context, proposed fix or implementation plan, affected files, tests to run, and uncertainty/remaining risks.",
		"Do not create GitHub issues, open PRs, push branches, or perform remote writes unless the user explicitly confirms that action in this fresh session.",
	].join("\n");
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
	await fs.mkdir(artifactDir, { recursive: true });

	const redactions: RedactionState = { labels: new Set() };
	const recentMessages = context.messages.slice(-MAX_TRANSCRIPT_MESSAGES);
	const artifacts: ContributionPrepArtifact[] = [];
	const redact = (text: string) => redactContributionPrepText(text, context.cwd, redactions);

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
					`Session file: ${context.sessionFile ?? "(none)"}`,
					`Working directory: ${context.cwd}`,
					options.customInstructions || context.customInstructions
						? `Custom instructions: ${options.customInstructions ?? context.customInstructions}`
						: "Custom instructions: (none)",
				].join("\n"),
			),
		),
	);

	const gitHead = (await gitOutput(context.cwd, ["rev-parse", "HEAD"])) || null;
	const files = await changedFiles(context.cwd);
	artifacts.push(
		await writeArtifact(artifactDir, "changed-files.txt", "Changed files from git status", redact(files.join("\n"))),
	);
	artifacts.push(
		await writeArtifact(
			artifactDir,
			"git-diff.patch",
			"Bounded redacted git diff",
			redact(await gitOutput(context.cwd, ["diff", "--no-ext-diff"])),
		),
	);
	artifacts.push(
		await writeArtifact(
			artifactDir,
			"environment.md",
			"Redacted environment and reproduction metadata",
			redact(
				[
					`cwd: ${context.cwd}`,
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

	const manifest: ContributionPrepManifest = {
		schema_version: CONTRIBUTION_PREP_SCHEMA_VERSION,
		source_session_id: context.sessionId,
		created_at: createdAt,
		cwd: redact(context.cwd),
		git_head: gitHead,
		changed_files: files,
		artifacts,
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
		worker_prompt_path: workerPromptPath,
	};
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	let spawned = false;
	if (options.spawnWorker) {
		const spawn = options.spawn ?? spawnContributionPrepWorker;
		const command = resolveGjcCommand();
		await spawn(
			[command.cmd, ...command.args, "--no-skills", "--", `@${workerPromptPath}`],
			context.cwd,
			command.shell,
		);
		spawned = true;
	}

	return { manifestPath, workerPromptPath, artifactDir, changedFiles: files, spawned };
}
