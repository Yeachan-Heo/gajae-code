import { createHash } from "node:crypto";
import {
	PUBLIC_COMMANDS,
	PUBLIC_HELP_SECTIONS,
	type PublicCommandDescriptor,
	type PublicHelpSection,
} from "./public-command-registry";

export const PUBLIC_HELP_MAX_BYTES = 8192;
const FRAGMENT_BYTES = 1024;

export interface PublicHelpOptions {
	json?: boolean;
	section?: string;
	page?: string | number;
	revision?: string;
}
export type PublicHelpErrorCode =
	| "unknown_command"
	| "invalid_section"
	| "invalid_page"
	| "invalid_revision"
	| "revision_mismatch"
	| "static_metadata_too_large"
	| "invalid_registry";
export class PublicHelpError extends Error {
	readonly exitCode: 2 | 1;
	constructor(readonly code: PublicHelpErrorCode) {
		super(
			{
				unknown_command: "Unknown public command. Request help at the nearest known command.",
				invalid_section: "Select a documented help section.",
				invalid_page: "Select an available positive decimal safe-integer help page.",
				invalid_revision: "Help revision must be a lowercase SHA256 digest.",
				revision_mismatch: "Help metadata changed. Begin a new help traversal without the old revision.",
				static_metadata_too_large: "Static help metadata cannot fit the output budget.",
				invalid_registry: "Static help registry contains an invalid command relationship or value.",
			}[code],
		);
		this.name = "PublicHelpError";
		this.exitCode = code === "static_metadata_too_large" || code === "invalid_registry" ? 1 : 2;
	}
}
export interface PublicHelpEntry {
	id: string;
	kind: "overview" | "usage" | "child" | "argument" | "option" | "example" | "recovery";
	complete: true;
	value: unknown;
}
export interface PublicHelpFragment {
	id: string;
	kind: "fragment";
	complete: false;
	encoding: "base64";
	offsetBytes: number;
	totalBytes: number;
	sha256: string;
	data: string;
}
export interface PublicHelpNext {
	section: PublicHelpSection;
	page: number;
	executable: "gjc";
	argv: string[];
}
export interface PublicHelpDocument {
	schema: "gjc.command-help";
	version: 1;
	ok: true;
	command: readonly string[];
	canonicalCommand: readonly string[];
	revision: string;
	section: PublicHelpSection;
	page: number;
	sections: readonly PublicHelpSection[];
	entries: readonly (PublicHelpEntry | PublicHelpFragment)[];
	sectionComplete: boolean;
	documentComplete: boolean;
	next: PublicHelpNext | null;
}
export interface PublicHelpRenderResult {
	/** Complete serialization including its single trailing newline. No output is written. */
	output: string;
	bytes: number;
	document: PublicHelpDocument;
}

/** Sorted object keys; array ordering is semantic. JSON escaping preserves lone surrogates. */
function canonicalJson(value: unknown): string {
	const normalize = (item: unknown): unknown => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (Array.isArray(item)) return item.map(value => (value === undefined ? null : normalize(value)));
		if (item && typeof item === "object") {
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(item).sort()) {
				const value = (item as Record<string, unknown>)[key];
				if (value !== undefined) Object.defineProperty(result, key, { value: normalize(value), enumerable: true });
			}
			return result;
		}
		throw new PublicHelpError("invalid_registry");
	};
	return JSON.stringify(normalize(value));
}
function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** The digest covers every descriptor and this renderer's paging/schema policy. */
export function getPublicHelpRevision(registry: readonly PublicCommandDescriptor[] = PUBLIC_COMMANDS): string {
	return sha256(
		canonicalJson({
			schema: "gjc.command-help",
			version: 1,
			pagingVersion: 1,
			maxBytes: PUBLIC_HELP_MAX_BYTES,
			fragmentBytes: FRAGMENT_BYTES,
			sections: PUBLIC_HELP_SECTIONS,
			registry,
			entryOrder: registry.map(row => ({ arguments: Object.keys(row.args), options: Object.keys(row.flags) })),
		}),
	);
}

function entriesFor(
	descriptor: PublicCommandDescriptor,
	registry: readonly PublicCommandDescriptor[],
): Record<PublicHelpSection, PublicHelpEntry[]> {
	const prefix = descriptor.command.join("/");
	const entry = (
		section: PublicHelpSection,
		key: string,
		kind: PublicHelpEntry["kind"],
		value: unknown,
	): PublicHelpEntry => ({ id: `${prefix}/${section}/${key}`, kind, complete: true, value });
	const sections: Record<PublicHelpSection, PublicHelpEntry[]> = {
		overview: [],
		usage: descriptor.usage.map((value, index) => entry("usage", String(index + 1), "usage", value)),
		children: descriptor.children.map(token => {
			const path = [...descriptor.command, token];
			const child = registry.find(
				row => row.command.length === path.length && row.command.every((part, index) => part === path[index]),
			);
			if (!child) throw new PublicHelpError("invalid_registry");
			return entry("children", token, "child", {
				command: child.command,
				canonicalCommand: child.canonicalCommand,
				description: child.description,
				help: { executable: "gjc", argv: [...child.command, "--help"] },
			});
		}),
		arguments: Object.entries(descriptor.args).map(([name, arg]) =>
			entry("arguments", name, "argument", {
				name,
				required: arg.required ?? false,
				multiple: arg.multiple ?? false,
				description: arg.description,
				...(arg.options ? { choices: arg.options } : {}),
			}),
		),
		options: Object.entries(descriptor.flags).map(([name, flag]) =>
			entry("options", name, "option", {
				name: `--${name}`,
				type: flag.kind,
				...(flag.char ? { short: `-${flag.char}` } : {}),
				required: flag.required ?? false,
				multiple: flag.multiple ?? false,
				...(flag.default !== undefined ? { default: flag.default } : {}),
				...(flag.options ? { choices: flag.options } : {}),
				description: flag.description,
				...(flag.conflicts ? { conflicts: flag.conflicts.map(name => `--${name}`) } : {}),
				...(flag.requires ? { requires: flag.requires.map(name => `--${name}`) } : {}),
				...(flag.risk ? { risk: flag.risk } : {}),
			}),
		),
		examples: descriptor.examples.map((value, index) => entry("examples", String(index + 1), "example", value)),
		recovery: descriptor.recovery.map((value, index) => entry("recovery", String(index + 1), "recovery", value)),
	};
	// Constraints belong to recovery, so overview can reference rather than duplicate them.
	for (const [index, description] of descriptor.constraints.entries())
		sections.recovery.push(
			entry("recovery", `constraint-${index + 1}`, "recovery", {
				description,
				disruption: "none",
				requiresConfirmation: false,
			}),
		);
	if (descriptor.risk)
		sections.recovery.push(
			entry("recovery", "risk", "recovery", {
				description: descriptor.risk,
				disruption: "interrupts-work",
				requiresConfirmation: true,
			}),
		);
	if (descriptor.exactlyOneOf?.length)
		sections.usage.push(
			entry("usage", "exclusive-options", "usage", {
				syntax: `Exactly one option is required in each group: ${descriptor.exactlyOneOf.map(group => group.map(name => `--${name}`).join(" | ")).join("; ")}`,
				executable: false,
			}),
		);
	sections.overview.push(
		entry("overview", "summary", "overview", {
			description: descriptor.description,
			...(descriptor.defaultChild ? { defaultCommand: [...descriptor.command, descriptor.defaultChild] } : {}),
			entries: PUBLIC_HELP_SECTIONS.filter(section => section !== "overview").map(section => ({
				section,
				ids: sections[section].map(value => value.id),
			})),
		}),
	);
	return sections;
}

/** JSON literals are display values, not shell commands; escape terminal controls explicitly. */
function display(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\u2028\u2029]/g,
		character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
function serialize(document: PublicHelpDocument, json: boolean): string {
	if (json) return `${JSON.stringify(document)}\n`;
	return `${[
		`COMMAND ${display(document.command)}`,
		`CANONICAL COMMAND ${display(document.canonicalCommand)}`,
		`REVISION ${document.revision}`,
		`SECTION ${document.section} PAGE ${document.page}`,
		`SECTIONS ${display(document.sections)}`,
		"ENTRIES (JSON display literals; do not paste escaped strings as shell argv)",
		...document.entries.map(entry => display(entry)),
		`SECTION COMPLETE ${document.sectionComplete}`,
		`DOCUMENT COMPLETE ${document.documentComplete}`,
		`CONTINUATION ${display(document.next)}`,
	].join("\n")}\n`;
}
function pageNumber(value: PublicHelpOptions["page"]): number {
	if (value === undefined) return 1;
	if (typeof value === "string" && !/^[0-9]+$/.test(value)) throw new PublicHelpError("invalid_page");
	const page = Number(value);
	if (!Number.isSafeInteger(page) || page < 1) throw new PublicHelpError("invalid_page");
	return page;
}

/**
 * Pure command-local rendering. Each page holds one complete entry or one byte fragment;
 * empty sections still have page 1. This keeps traversal stable and independently bounded.
 * The optional registry supports isolated static fixtures without replacing global state.
 */
export function renderPublicCommandHelp(
	command: readonly string[],
	options: PublicHelpOptions = {},
	registry: readonly PublicCommandDescriptor[] = PUBLIC_COMMANDS,
): PublicHelpRenderResult {
	const descriptor = registry.find(
		row => row.command.length === command.length && row.command.every((part, index) => part === command[index]),
	);
	if (!descriptor) throw new PublicHelpError("unknown_command");
	const section = options.section ?? "overview";
	if (!(PUBLIC_HELP_SECTIONS as readonly string[]).includes(section)) throw new PublicHelpError("invalid_section");
	const selectedSection = section as PublicHelpSection;
	const page = pageNumber(options.page);
	if (options.revision !== undefined && !/^[0-9a-f]{64}$/.test(options.revision))
		throw new PublicHelpError("invalid_revision");
	const revision = getPublicHelpRevision(registry);
	if (options.revision !== undefined && options.revision !== revision) throw new PublicHelpError("revision_mismatch");
	const json = options.json === true;
	const next = (section: PublicHelpSection, page: number): PublicHelpNext => ({
		section,
		page,
		executable: "gjc",
		argv: [
			...descriptor.command,
			"--help",
			"--help-revision",
			revision,
			"--help-section",
			section,
			"--help-page",
			String(page),
			...(json ? ["--json"] : []),
		],
	});
	const document = (
		section: PublicHelpSection,
		page: number,
		entries: PublicHelpDocument["entries"],
		sectionComplete: boolean,
		continuation: PublicHelpNext | null,
	): PublicHelpDocument => ({
		schema: "gjc.command-help",
		version: 1,
		ok: true,
		command: descriptor.command,
		canonicalCommand: descriptor.canonicalCommand,
		revision,
		section,
		page,
		sections: PUBLIC_HELP_SECTIONS,
		entries,
		sectionComplete,
		documentComplete: continuation === null,
		next: continuation,
	});
	// Reserve the longest section name and largest safe page number in both metadata and argv.
	// false is one byte longer than true; a continuation is always larger than null.
	const reservedBytes = (entries: PublicHelpDocument["entries"]): number =>
		Buffer.byteLength(
			serialize(
				document("arguments", Number.MAX_SAFE_INTEGER, entries, false, next("arguments", Number.MAX_SAFE_INTEGER)),
				json,
			),
		);
	if (reservedBytes([]) > PUBLIC_HELP_MAX_BYTES) throw new PublicHelpError("static_metadata_too_large");
	const pages: (PublicHelpEntry | PublicHelpFragment)[] = [];
	for (const entry of entriesFor(descriptor, registry)[selectedSection]) {
		if (reservedBytes([entry]) <= PUBLIC_HELP_MAX_BYTES) {
			pages.push(entry);
			continue;
		}
		const bytes = Buffer.from(canonicalJson(entry.value), "utf8");
		const digest = sha256(bytes);
		for (let offset = 0; offset < bytes.length; offset += FRAGMENT_BYTES) {
			const fragment: PublicHelpFragment = {
				id: entry.id,
				kind: "fragment",
				complete: false,
				encoding: "base64",
				offsetBytes: offset,
				totalBytes: bytes.length,
				sha256: digest,
				data: bytes.subarray(offset, offset + FRAGMENT_BYTES).toString("base64"),
			};
			if (reservedBytes([fragment]) > PUBLIC_HELP_MAX_BYTES) throw new PublicHelpError("static_metadata_too_large");
			pages.push(fragment);
		}
	}
	const pageCount = Math.max(1, pages.length);
	if (page > pageCount) throw new PublicHelpError("invalid_page");
	const sectionComplete = page === pageCount;
	const followingSection = PUBLIC_HELP_SECTIONS[PUBLIC_HELP_SECTIONS.indexOf(selectedSection) + 1];
	const continuation = !sectionComplete
		? next(selectedSection, page + 1)
		: followingSection
			? next(followingSection, 1)
			: null;
	const result = document(
		selectedSection,
		page,
		pages.length ? [pages[page - 1]!] : [],
		sectionComplete,
		continuation,
	);
	const output = serialize(result, json);
	const bytes = Buffer.byteLength(output);
	if (bytes > PUBLIC_HELP_MAX_BYTES) throw new PublicHelpError("static_metadata_too_large");
	return { output, bytes, document: result };
}
