import { Args, Command, Flags } from "@gajae-code/utils/cli";
import type {
	FilesystemMemoryMapV1,
	FilesystemMemoryOutcome,
	FilesystemMemoryScope,
	FilesystemMemoryUri,
} from "../memory-filesystem/contracts";
import {
	doctorFilesystemMemory,
	FILESYSTEM_MEMORY_CAPABILITIES,
	getFilesystemMemoryDocument,
	parseFilesystemMemoryMap,
	recallFilesystemMemory,
	resolveFilesystemMemoryMapRoute,
	searchFilesystemMemory,
} from "../memory-filesystem/index";
import {
	checkpointFilesystemMemory,
	getFilesystemMemoryRoots,
	initializeFilesystemMemory,
	resumeFilesystemMemory,
} from "../memory-filesystem/lifecycle";
import { readSafeFilesystemMemoryFile } from "../memory-filesystem/safe-path";
import { parseFilesystemMemoryUri } from "../memory-filesystem/uri";

const SCOPES = new Set<FilesystemMemoryScope>(["global", "project", "project-local", "session"]);
type Format = "text" | "json" | "jsonl";
function exitCode(code: string): number {
	return code === "ok"
		? 0
		: code === "not_found"
			? 3
			: code === "policy_denied" || code === "permission_denied"
				? 4
				: 2;
}
function write(format: Format, value: unknown): void {
	if (format === "text")
		process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
	else process.stdout.write(`${JSON.stringify(value)}\n`);
}
function output(format: Format, result: FilesystemMemoryOutcome<unknown>): void {
	write(
		format,
		result.code === "ok" ? { code: "ok", value: result.value } : { code: result.code, message: result.message },
	);
	process.exitCode = Math.max(Number(process.exitCode) || 0, exitCode(result.code));
}
function scopes(value: string | undefined): readonly FilesystemMemoryScope[] | null {
	if (!value) return ["global", "project", "project-local", "session"];
	const result = value.split(",").map(scope => scope.trim()) as FilesystemMemoryScope[];
	return result.length && result.every(scope => SCOPES.has(scope)) ? result : null;
}
async function readInput(input: string | undefined): Promise<string> {
	return input ?? (await Bun.stdin.text());
}

export default class Memory extends Command {
	static description = "Manage independent opt-in filesystem and MAP memory";
	static args = {
		action: Args.string({
			description: "init|scopes|resolve|get|search|recall|checkpoint|resume|doctor|capabilities",
			required: true,
		}),
		values: Args.string({ description: "Command arguments", multiple: true, required: false }),
	};
	static flags = {
		format: Flags.string({ description: "Output format: text | json | jsonl", default: "text" }),
		scope: Flags.string({ description: "Comma-separated scopes for init" }),
		input: Flags.string({ description: "Structured JSON input; stdin when omitted" }),
		"expected-digest": Flags.string({ description: "Required current checkpoint digest for replacement" }),
		limit: Flags.integer({ description: "Bounded search result limit" }),
		map: Flags.string({ description: "Logical MAP URI for route-prioritized search or recall" }),
		route: Flags.string({ description: "MAP route ID for route-prioritized search or recall" }),
	};
	static examples = [
		"gjc memory init --scope global,project",
		"gjc memory get project:///MEMORY.md --format json",
		'gjc memory checkpoint --input \'{"taskId":"task","sessionId":"session","content":"state"}\'',
		"gjc memory resume task --format json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Memory);
		const format = flags.format;
		if (format !== "text" && format !== "json" && format !== "jsonl") {
			output("json", { code: "invalid_path", message: "--format must be text, json, or jsonl." });
			return;
		}
		const action = args.action;
		const values = (args.values ?? []).filter((value): value is string => typeof value === "string");
		if (action === "init") {
			const selected = scopes(typeof flags.scope === "string" ? flags.scope : undefined);
			output(
				format,
				selected
					? await initializeFilesystemMemory(selected)
					: { code: "invalid_path", message: "--scope contains an unknown scope." },
			);
			return;
		}
		if (action === "scopes") {
			output(format, await getFilesystemMemoryRoots());
			return;
		}
		if (action === "checkpoint") {
			await this.checkpoint(
				format,
				typeof flags.input === "string" ? flags.input : undefined,
				typeof flags["expected-digest"] === "string" ? flags["expected-digest"] : undefined,
			);
			return;
		}
		if (action === "resume") {
			output(
				format,
				values[0]
					? await resumeFilesystemMemory(values[0])
					: { code: "invalid_path", message: "resume requires TASK_ID." },
			);
			return;
		}
		if (action === "capabilities") {
			output(format, { code: "ok", value: FILESYSTEM_MEMORY_CAPABILITIES });
			return;
		}
		if (
			action === "get" ||
			action === "resolve" ||
			action === "search" ||
			action === "recall" ||
			action === "doctor"
		) {
			await this.retrieval(
				action,
				values,
				format,
				typeof flags.limit === "number" ? flags.limit : undefined,
				typeof flags.map === "string" ? flags.map : undefined,
				typeof flags.route === "string" ? flags.route : undefined,
			);
			return;
		}
		output(format, { code: "invalid_path", message: `Unknown memory action: ${action}.` });
	}

	private async checkpoint(
		format: Format,
		input: string | undefined,
		expectedDigest: string | undefined,
	): Promise<void> {
		const raw = await readInput(input);
		if (format !== "jsonl") {
			try {
				const parsed = JSON.parse(raw) as { taskId?: unknown; sessionId?: unknown; content?: unknown };
				if (
					typeof parsed.taskId !== "string" ||
					typeof parsed.sessionId !== "string" ||
					typeof parsed.content !== "string"
				)
					throw new Error();
				output(
					format,
					await checkpointFilesystemMemory({
						taskId: parsed.taskId,
						sessionId: parsed.sessionId,
						content: parsed.content,
						expectedDigest,
					}),
				);
			} catch {
				output(format, {
					code: "invalid_path",
					message: "checkpoint input must be a JSON object with taskId, sessionId, and content strings.",
				});
			}
			return;
		}
		let failed = false;
		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as {
					taskId?: unknown;
					sessionId?: unknown;
					content?: unknown;
					expectedDigest?: unknown;
				};
				if (
					typeof parsed.taskId !== "string" ||
					typeof parsed.sessionId !== "string" ||
					typeof parsed.content !== "string"
				)
					throw new Error();
				const result = await checkpointFilesystemMemory({
					taskId: parsed.taskId,
					sessionId: parsed.sessionId,
					content: parsed.content,
					expectedDigest: typeof parsed.expectedDigest === "string" ? parsed.expectedDigest : expectedDigest,
				});
				write("jsonl", result.code === "ok" ? { code: "ok", value: result.value } : result);
				if (result.code !== "ok") failed = true;
			} catch {
				write("jsonl", { code: "invalid_path", message: "checkpoint JSONL record is invalid." });
				failed = true;
			}
		}
		if (failed) process.exitCode = Math.max(Number(process.exitCode) || 0, 2);
	}

	private async retrieval(
		action: string,
		values: string[],
		format: Format,
		limit: number | undefined,
		mapUri: string | undefined,
		routeId: string | undefined,
	): Promise<void> {
		const roots = await getFilesystemMemoryRoots();
		if (roots.code !== "ok") {
			output(format, roots);
			return;
		}
		if (action === "get") {
			const parsed: FilesystemMemoryOutcome<FilesystemMemoryUri> = values[0]
				? parseFilesystemMemoryUri(values[0])
				: { code: "invalid_uri", message: "get requires URI." };
			if (parsed.code !== "ok") {
				output(format, parsed);
				return;
			}
			output(format, await getFilesystemMemoryDocument(roots.value.roots, parsed.value.canonical));
			return;
		}
		if (action === "resolve") {
			const parsed: FilesystemMemoryOutcome<FilesystemMemoryUri> = values[0]
				? parseFilesystemMemoryUri(values[0])
				: { code: "invalid_uri", message: "resolve requires MAP_URI and ROUTE." };
			if (parsed.code !== "ok") {
				output(format, parsed);
				return;
			}
			if (!values[1]) {
				output(format, { code: "invalid_path", message: "resolve requires MAP_URI and ROUTE." });
				return;
			}
			const mapLeaf = parsed.value.components.at(-1);
			if (mapLeaf !== "memory.yaml" && mapLeaf !== "memory.json") {
				output(format, { code: "invalid_path", message: "resolve requires a memory.yaml or memory.json URI." });
				return;
			}
			const root = roots.value.roots[parsed.value.scope];
			if (!root) {
				output(format, { code: "policy_denied", message: "Memory scope is unavailable." });
				return;
			}
			const read = await readSafeFilesystemMemoryFile(root, parsed.value.components);
			if (read.code !== "ok") {
				output(format, read);
				return;
			}
			try {
				const map = parseFilesystemMemoryMap(new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes));
				output(format, map.code === "ok" ? resolveFilesystemMemoryMapRoute(map.value, values[1]) : map);
			} catch {
				output(format, { code: "invalid_path", message: "MAP document is not UTF-8." });
			}
			return;
		}
		if (action === "doctor") {
			output(format, {
				code: "ok",
				value: await doctorFilesystemMemory(roots.value.roots, roots.value.availability),
			});
			return;
		}
		const query = values.join(" ").trim();
		if (!query) {
			output(format, { code: "invalid_path", message: `${action} requires QUERY.` });
			return;
		}
		if ((mapUri && !routeId) || (!mapUri && routeId)) {
			output(format, { code: "invalid_path", message: "--map and --route must be provided together." });
			return;
		}
		let map: FilesystemMemoryMapV1 | undefined;
		if (mapUri && routeId) {
			const parsed = parseFilesystemMemoryUri(mapUri);
			if (parsed.code !== "ok") {
				output(format, parsed);
				return;
			}
			const root = roots.value.roots[parsed.value.scope];
			if (!root) {
				output(format, { code: "policy_denied", message: "MAP scope is unavailable." });
				return;
			}
			const read = await readSafeFilesystemMemoryFile(root, parsed.value.components);
			if (read.code !== "ok") {
				output(format, read);
				return;
			}
			try {
				const parsedMap = parseFilesystemMemoryMap(
					new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes),
				);
				if (parsedMap.code !== "ok") {
					output(format, parsedMap);
					return;
				}
				map = parsedMap.value;
			} catch {
				output(format, { code: "invalid_path", message: "MAP document is not UTF-8." });
				return;
			}
		}
		const options = { query, limit, map, routeId };
		output(
			format,
			action === "search"
				? await searchFilesystemMemory(roots.value.roots, options)
				: await recallFilesystemMemory(roots.value.roots, options),
		);
	}
}
