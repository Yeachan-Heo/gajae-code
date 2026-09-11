import * as path from "node:path";
import { CliParseError, type CommandCtor, type CommandEntryContext } from "@gajae-code/utils/cli";
import { getAgentDir } from "@gajae-code/utils/dirs";
import {
	PublicCommandFailure,
	renderPublicCommandFailure,
	renderPublicEvidenceUnavailable,
} from "./public-command-errors";
import { EVIDENCE_LIMITS, type EvidencePage, readCommandEvidence } from "./public-command-evidence";
import { PublicHelpError, renderPublicCommandHelp } from "./public-command-help";
import {
	getPublicCommand,
	type PublicCommandDescriptor,
	type PublicCommandFamily,
	type PublicFlagDescriptor,
	type PublicHelpSection,
} from "./public-command-registry";

export type PublicUsageIssueCode =
	| "unknown-path"
	| "unknown-flag"
	| "missing-value"
	| "invalid-value"
	| "duplicate-flag"
	| "missing-flag"
	| "missing-argument"
	| "unexpected-argument"
	| "conflict"
	| "requires"
	| "exclusive";
/** Only descriptor-owned names and static messages are safe for output. Never include argv values. */
export interface PublicUsageIssue {
	code: PublicUsageIssueCode;
	message: string;
	field?: string;
}
export interface PublicHelpOptions {
	section: PublicHelpSection;
	page: number;
	revision?: string;
}
export interface PublicRetrievalOptions {
	id: string;
	sha256: string;
	page: number;
	agentDir?: string;
}
interface PublicScanBase {
	descriptor: PublicCommandDescriptor;
	mode: "text" | "json";
	args: Record<string, string | string[] | undefined>;
	flags: Record<string, unknown>;
	/** Family-relative argv, retaining child paths and operation tokens in their original order. */
	operationArgv: string[];
	help: PublicHelpOptions;
	retrieval?: PublicRetrievalOptions;
}
export type PublicCommandScan = PublicScanBase &
	({ kind: "usage"; issues: PublicUsageIssue[] } | { kind: "help" | "retrieval" | "operation"; issues: [] });

function validValue(value: string, flag: PublicFlagDescriptor): boolean {
	if (flag.options && !flag.options.includes(value)) return false;
	if (flag.kind === "integer" && (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) return false;
	switch (flag.validation) {
		case "sha256":
			return /^[a-f0-9]{64}$/.test(value);
		case "error-id":
			return /^[a-f0-9]{32}$/.test(value);
		case "positive-safe-integer":
			return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
		case "search-limit":
			return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100;
		case "pending-ceiling":
			return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 262144;
		default:
			return true;
	}
}

/** Inert, descriptor-driven scanner. argv excludes the already resolved family token. */
export function scanPublicCommand(family: PublicCommandFamily, argv: readonly string[]): PublicCommandScan {
	let descriptor = getPublicCommand([family])!;
	const flags: Record<string, unknown> = {};
	const args: PublicScanBase["args"] = {};
	const seen = new Set<string>();
	const operationArgv: string[] = [];
	const positionals: string[] = [];
	const issues: PublicUsageIssue[] = [];
	let mode: PublicScanBase["mode"] = "text";
	let helpRequested = false;
	let retrievalRequested = false;
	let ended = false;
	let pathClosed = false;
	const issue = (code: PublicUsageIssueCode, message: string, field?: string) => {
		if (!issues.some(item => item.code === code && item.field === field))
			issues.push({ code, message, ...(field ? { field } : {}) });
	};
	const consumeFlag = (name: string, flag: PublicFlagDescriptor, value: string | undefined, inline: boolean): void => {
		if (seen.has(name) && (flag.boundary || descriptor.command.join(" ") === "sdk serve") && !flag.multiple)
			issue("duplicate-flag", "Option must occur only once.", name);
		seen.add(name);
		if (flag.boundary === "retrieval") retrievalRequested = true;
		if (flag.kind === "boolean") {
			if (inline) {
				issue("invalid-value", "Boolean option does not accept an operand.", name);
				return;
			}
			flags[name] = true;
			if (name === "json") mode = "json";
			if (name === "help") helpRequested = true;
			return;
		}
		if (value === undefined) {
			issue("missing-value", "Option requires an operand.", name);
			return;
		}
		if (inline && flag.valueSyntax === "separate")
			issue("invalid-value", "Option requires a separate operand.", name);
		if (!validValue(value, flag)) issue("invalid-value", "Option operand is invalid.", name);
		const parsed = flag.kind === "integer" ? Number(value) : value;
		flags[name] = flag.multiple
			? [...(Array.isArray(flags[name]) ? (flags[name] as unknown[]) : []), parsed]
			: parsed;
	};
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index]!;
		if (!ended && token === "--") {
			ended = true;
			pathClosed = true;
			operationArgv.push(token);
			continue;
		}
		if (!ended && token.startsWith("-") && token !== "-") {
			const start = index;
			let keep = false;
			const long = token.startsWith("--");
			const equals = long ? token.indexOf("=") : -1;
			const names = long ? [token.slice(2, equals < 0 ? undefined : equals)] : token.slice(1).split("");
			const shortOperationTokens: string[] = [];
			for (let shortIndex = 0; shortIndex < names.length; shortIndex++) {
				const rawName = names[shortIndex]!;
				const name = long
					? rawName
					: Object.keys(descriptor.flags).find(key => descriptor.flags[key]!.char === rawName);
				const flag =
					name === undefined
						? undefined
						: Object.hasOwn(descriptor.flags, name)
							? descriptor.flags[name]
							: undefined;
				if (!name || !flag) {
					issue("unknown-flag", "Unknown option for this command.");
					keep = true;
					if (!long) shortOperationTokens.push(`-${rawName}`);
					continue;
				}
				if (!flag.boundary) keep = true;
				let inline = long && equals >= 0;
				let value = inline ? token.slice(equals + 1) : undefined;
				if (flag.kind !== "boolean") {
					if (!long && shortIndex + 1 < names.length) {
						inline = true;
						value = names.slice(shortIndex + 1).join("");
						shortIndex = names.length;
					}
					if (
						!inline &&
						argv[index + 1] !== undefined &&
						(argv[index + 1] === "-" || !argv[index + 1]!.startsWith("-"))
					)
						value = argv[++index];
				}
				consumeFlag(name, flag, value, inline);
				if (!long && !flag.boundary) {
					shortOperationTokens.push(`-${rawName}${inline ? (value ?? "") : ""}`);
					if (!inline && value !== undefined) shortOperationTokens.push(value);
				}
			}
			if (keep) {
				// Split short clusters so boundary characters cannot reach the operation parser.
				if (!long) operationArgv.push(...shortOperationTokens);
				else operationArgv.push(...argv.slice(start, index + 1));
			}
			continue;
		}
		if (!pathClosed && descriptor.children.includes(token)) {
			descriptor = getPublicCommand([...descriptor.command, token])!;
			operationArgv.push(token);
			continue;
		}
		pathClosed = true;
		positionals.push(token);
		operationArgv.push(token);
		if (descriptor.children.length && !descriptor.defaultChild) issue("unknown-path", "Unknown command path.");
	}
	for (const [name, flag] of Object.entries(descriptor.flags)) {
		if (flags[name] === undefined && flag.default !== undefined) flags[name] = flag.default;
		if (!helpRequested && !retrievalRequested && flag.required && !seen.has(name))
			issue("missing-flag", "Required option is missing.", name);
		if (!seen.has(name)) continue;
		for (const required of flag.requires ?? [])
			if (!seen.has(required)) issue("requires", "Option requires another option.", name);
		for (const conflict of flag.conflicts ?? [])
			if (seen.has(conflict)) issue("conflict", "Options are mutually exclusive.", name);
	}
	let positionalIndex = 0;
	for (const [name, arg] of Object.entries(descriptor.args)) {
		const values = arg.multiple
			? positionals.slice(positionalIndex)
			: positionals.slice(positionalIndex, positionalIndex + 1);
		positionalIndex += values.length;
		args[name] = arg.multiple ? (values.length ? values : undefined) : values[0];
		if (!helpRequested && !retrievalRequested && arg.required && !values.length)
			issue("missing-argument", "Required argument is missing.", name);
		// Daemon kind choices are help metadata; runtime owns unknown-kind exit 1.
		if (
			!(descriptor.command[0] === "daemon" && name === "kind") &&
			arg.options &&
			values.some(value => !arg.options!.includes(value))
		)
			issue("invalid-value", "Argument value is invalid.", name);
	}
	if (positionalIndex < positionals.length && !issues.some(item => item.code === "unknown-path"))
		issue("unexpected-argument", "Unexpected argument for this command.");
	if (!helpRequested && !retrievalRequested) {
		if (descriptor.children.length && !descriptor.defaultChild && !positionals.length)
			issue("unknown-path", "A child command is required.");
		for (const group of descriptor.exactlyOneOf ?? [])
			if (group.filter(name => seen.has(name)).length !== 1)
				issue("exclusive", "Exactly one transport option is required.");
	}
	if (retrievalRequested && (descriptor.command.length !== 1 || helpRequested || operationArgv.length > 0))
		issue("exclusive", "Evidence retrieval is exclusive with help and operations.");
	// Root selectors consumed before a child must still be rejected on that child.
	for (const name of seen)
		if (!Object.hasOwn(descriptor.flags, name)) issue("unknown-flag", "Option is not available on this command.");
	const help: PublicHelpOptions = {
		section: (flags["help-section"] ?? "overview") as PublicHelpSection,
		page: Number(flags["help-page"] ?? 1),
		...(typeof flags["help-revision"] === "string" ? { revision: flags["help-revision"] } : {}),
	};
	const retrieval = retrievalRequested
		? {
				id: String(flags["error-ref"] ?? ""),
				sha256: String(flags["error-sha256"] ?? ""),
				page: Number(flags["error-page"] ?? 1),
				...(typeof flags["error-agent-dir"] === "string" ? { agentDir: flags["error-agent-dir"] } : {}),
			}
		: undefined;
	const base: PublicScanBase = {
		descriptor,
		mode,
		args,
		flags,
		operationArgv,
		help,
		...(retrieval ? { retrieval } : {}),
	};
	if (issues.length) return { ...base, kind: "usage", issues };
	return { ...base, kind: retrievalRequested ? "retrieval" : helpRequested ? "help" : "operation", issues: [] };
}

export interface PublicCommandDispatchContext extends CommandEntryContext {
	command: PublicCommandFamily;
	load: () => Promise<CommandCtor>;
	/** Only operations may initialize settings, transports, themes or runtime globals. */
	setup?: (report: (diagnostic: { code: "macos_nofile_limit_low"; successStderr: string }) => void) => Promise<void>;
}

export function isSafeSdkInternalAgentDir(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 4096 &&
		path.isAbsolute(value) &&
		!value.startsWith("-") &&
		!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value)
	);
}

/** Mirrors commands/sdk.ts parseSdkInternalArgv without eagerly loading its runtime. */
export function isSdkInternalArgv(argv: readonly string[]): boolean {
	return (
		(argv[0] === "session-host-internal" && argv.length === 1) ||
		(argv[0] === "broker-internal" &&
			argv.length === 3 &&
			argv[1] === "--agent-dir" &&
			typeof argv[2] === "string" &&
			isSafeSdkInternalAgentDir(argv[2]))
	);
}

function evidencePageOutput(page: EvidencePage, json: boolean): string {
	if (json) return `${JSON.stringify(page)}\n`;
	// JSON-quoted fields keep control characters out of terminal output and preserve exact locators.
	return `${[
		`Command error evidence ${JSON.stringify(page.id)}`,
		`SHA256: ${page.sha256}`,
		`Expires: ${page.expiresAt}`,
		`Page: ${page.page}; complete: ${page.complete}`,
		...page.fragments.map(fragment => `Fragment: ${JSON.stringify(fragment)}`),
		`Next: ${JSON.stringify(page.next).replace(/[\u007f-\u009f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`,
	].join("\n")}\n`;
}

/** Single family boundary, shared by early bootstrap routing and registered utility dispatch. */
export async function dispatchPublicCommand(
	argv: readonly string[],
	context: PublicCommandDispatchContext,
): Promise<void> {
	// Exact private spawn contracts retain the original runtime and error ownership.
	// Malformed worker-like input still belongs to the safe public usage boundary.
	if (context.command === "sdk" && isSdkInternalArgv(argv)) {
		await context.setup?.(diagnostic => {
			process.stderr.write(diagnostic.successStderr);
		});
		const Cmd = await context.load();
		await new Cmd([...argv], {
			bin: context.bin,
			version: context.version,
			commands: new Map([[context.command, Cmd]]),
		}).run();
		return;
	}
	const scan = scanPublicCommand(context.command, argv);
	const json = scan.mode === "json";
	const options = { command: scan.descriptor.command, json };
	let agentDir: string | undefined;
	const scopeAgentDir = typeof scan.flags["agent-dir"] === "string" ? scan.flags["agent-dir"] : undefined;
	let successStderr = "";
	let noFileWarning = false;
	const emit = (result: { stdout: string; stderr: string; exitCode: number }) => {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.exitCode;
	};
	try {
		if (scan.kind === "usage") throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
		if (scan.kind === "help") {
			process.stdout.write(renderPublicCommandHelp(scan.descriptor.command, { ...scan.help, json }).output);
			return;
		}
		if (scan.kind === "retrieval") {
			const retrieval = scan.retrieval!;
			const result = await readCommandEvidence({
				family: context.command,
				agentDir: retrieval.agentDir ?? getAgentDir(),
				scopeAgentDir: retrieval.agentDir,
				json,
				id: retrieval.id,
				sha256: retrieval.sha256,
				page: retrieval.page,
			});
			if (result.status === "unavailable") {
				if (result.reason === "invalid_request")
					emit(
						await renderPublicCommandFailure(
							new PublicCommandFailure({ kind: "usage", proof: "pre-effect" }),
							options,
						),
					);
				else emit(renderPublicEvidenceUnavailable(result, options));
				return;
			}
			const output = evidencePageOutput(result.page, json);
			if (Buffer.byteLength(output) > EVIDENCE_LIMITS.responseBytes) {
				emit(renderPublicEvidenceUnavailable({ reason: "locator_too_large", requiredBytes: null }, options));
				return;
			}
			process.stdout.write(output);
			return;
		}
		agentDir = scopeAgentDir ?? getAgentDir();
		await context.setup?.(diagnostic => {
			noFileWarning = true;
			if (successStderr) return;
			successStderr = diagnostic.successStderr;
		});
		const Cmd = await context.load();
		const operationArgv = [...scan.operationArgv];
		const successJson =
			context.command === "daemon" ||
			(scan.descriptor.command[0] === "sdk" &&
				(scan.descriptor.command[1] === "spawn" || scan.descriptor.command[1] === "search"));
		// Insert before --, never after it where the operation parser would see a positional.
		if (json && successJson) {
			const delimiter = operationArgv.indexOf("--");
			operationArgv.splice(delimiter < 0 ? operationArgv.length : delimiter, 0, "--json");
		}
		await new Cmd(operationArgv, {
			bin: context.bin,
			version: context.version,
			commands: new Map([[context.command, Cmd]]),
		}).run();
		if (successStderr) process.stderr.write(successStderr);
	} catch (error) {
		if (scan.kind === "retrieval") {
			emit(renderPublicEvidenceUnavailable({ reason: "io_error", requiredBytes: null }, options));
			return;
		}
		const failure =
			error instanceof CliParseError || (error instanceof PublicHelpError && error.exitCode === 2)
				? new PublicCommandFailure({ kind: "usage", proof: "pre-effect" })
				: error;
		emit(
			await renderPublicCommandFailure(failure, {
				...options,
				agentDir,
				scopeAgentDir,
				diagnostics: noFileWarning ? ["macos_nofile_limit_low"] : [],
			}),
		);
	}
}
