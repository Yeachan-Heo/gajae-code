/**
 * Minimal CLI framework — drop-in replacement for the subset of @oclif/core
 * actually used by the coding agent. Provides `Command`, `Args`, `Flags`,
 * and a `run()` entry point with explicit command registration.
 *
 * Design goals:
 *   - Zero dependencies beyond node builtins
 *   - No filesystem scanning, no manifest files, no plugin loading
 *   - Lazy command imports (only the invoked command is loaded)
 *   - Typed `this.parse()` output matching oclif's API shape
 */
import { parseArgs as nodeParseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Flag & Arg descriptors
// ---------------------------------------------------------------------------

export interface FlagDescriptor<K extends "string" | "boolean" | "integer" = "string" | "boolean" | "integer"> {
	kind: K;
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

export interface ArgDescriptor {
	kind: "string";
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

interface FlagInput {
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

interface ArgInput {
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

/** Builders that match the `Flags.*()` / `Args.*()` API from oclif. */
export const Flags = {
	string<T extends FlagInput>(opts?: T): FlagDescriptor<"string"> & T {
		return { kind: "string" as const, ...opts } as FlagDescriptor<"string"> & T;
	},
	boolean<T extends FlagInput>(opts?: T): FlagDescriptor<"boolean"> & T {
		return { kind: "boolean" as const, ...opts } as FlagDescriptor<"boolean"> & T;
	},
	integer<T extends FlagInput & { default?: number }>(opts?: T): FlagDescriptor<"integer"> & T {
		return { kind: "integer" as const, ...opts } as FlagDescriptor<"integer"> & T;
	},
};

export const Args = {
	string<T extends ArgInput>(opts?: T): ArgDescriptor & T {
		return { kind: "string" as const, ...opts } as ArgDescriptor & T;
	},
};

// ---------------------------------------------------------------------------
// Parse result types — mirrors oclif's typed output from this.parse()
// ---------------------------------------------------------------------------

type FlagValue<D extends FlagDescriptor> = D["kind"] extends "boolean"
	? D extends { default: boolean }
		? boolean
		: boolean | undefined
	: D["kind"] extends "integer"
		? D extends { default: number }
			? number
			: number | undefined
		: D extends { multiple: true }
			? string[] | undefined
			: string | undefined;

type ArgValue<D extends ArgDescriptor> = D extends { multiple: true } ? string[] | undefined : string | undefined;

type FlagValues<T extends Record<string, FlagDescriptor>> = { [K in keyof T]: FlagValue<T[K]> };
type ArgValues<T extends Record<string, ArgDescriptor>> = { [K in keyof T]: ArgValue<T[K]> };

export interface ParseOutput<
	F extends Record<string, FlagDescriptor> = Record<string, FlagDescriptor>,
	A extends Record<string, ArgDescriptor> = Record<string, ArgDescriptor>,
> {
	flags: FlagValues<F>;
	args: ArgValues<A>;
	argv: string[];
}

// ---------------------------------------------------------------------------
// Command base class
// ---------------------------------------------------------------------------

export interface CommandCtor {
	new (argv: string[], config: CliConfig): Command;
	description?: string;
	hidden?: boolean;
	strict?: boolean;
	aliases?: string[];
	examples?: string[];
	flags?: Record<string, FlagDescriptor>;
	args?: Record<string, ArgDescriptor>;
	delegateHelp?: boolean;
}

/** Configuration passed to every command instance and help renderers. */
export interface CliConfig {
	bin: string;
	version: string;
	/** All registered commands keyed by their canonical name. */
	commands: Map<string, CommandCtor>;
}

/** Minimal Command base matching the oclif surface we use. */
export abstract class Command {
	argv: string[];
	config: CliConfig;

	constructor(argv: string[], config: CliConfig) {
		this.argv = argv;
		this.config = config;
	}

	abstract run(): Promise<void>;

	/**
	 * Parse argv against the static `flags` and `args` declared on the
	 * concrete command class. Returns a typed `{ flags, args, argv }` object.
	 */
	async parse<C extends CommandCtor>(
		_Cmd: C,
	): Promise<
		ParseOutput<
			NonNullable<C["flags"]> extends Record<string, FlagDescriptor>
				? NonNullable<C["flags"]>
				: Record<string, FlagDescriptor>,
			NonNullable<C["args"]> extends Record<string, ArgDescriptor>
				? NonNullable<C["args"]>
				: Record<string, ArgDescriptor>
		>
	> {
		const Cmd = _Cmd as CommandCtor;
		const flagDefs = (Cmd.flags ?? {}) as Record<string, FlagDescriptor>;
		const argDefs = (Cmd.args ?? {}) as Record<string, ArgDescriptor>;
		const strict = Cmd.strict !== false;

		// Build node:util parseArgs options from flag descriptors
		const options: Record<
			string,
			{ type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
		> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const opt: (typeof options)[string] = {
				type: desc.kind === "boolean" ? "boolean" : "string",
			};
			if (desc.char) opt.short = desc.char;
			if (desc.multiple) opt.multiple = true;
			if (desc.default !== undefined) {
				opt.default = desc.kind === "boolean" ? Boolean(desc.default) : String(desc.default);
			}
			options[name] = opt;
		}

		// strict=false when command declares args (positionals must pass through)
		// or when the command itself opts out
		const { values: rawValues, positionals } = nodeParseArgs({
			args: this.argv,
			options,
			allowPositionals: true,
			strict,
		});

		// Convert raw values to proper types and validate
		const flags: Record<string, unknown> = {};
		for (const [name, desc] of Object.entries(flagDefs)) {
			const raw = rawValues[name];
			if (desc.kind === "integer") {
				if (raw === undefined || typeof raw === "boolean") {
					flags[name] = desc.default ?? undefined;
				} else {
					const n = Number.parseInt(raw as string, 10);
					if (Number.isNaN(n)) {
						throw new Error(`Expected integer for --${name}, got "${raw}"`);
					}
					flags[name] = n;
				}
			} else if (desc.kind === "boolean") {
				flags[name] =
					raw !== undefined ? Boolean(raw) : desc.default !== undefined ? Boolean(desc.default) : undefined;
			} else {
				// string
				const val = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);
				// Validate options constraint
				if (val !== undefined && desc.options && !Array.isArray(val)) {
					if (!desc.options.includes(val as string)) {
						throw new Error(`Expected --${name} to be one of: ${[...desc.options].join(", ")}; got "${val}"`);
					}
				}
				flags[name] = val;
			}
			// Validate required
			if (desc.required && flags[name] === undefined) {
				throw new Error(`Missing required flag: --${name}`);
			}
		}

		// Map positionals to named args in declaration order and validate
		const args: Record<string, unknown> = {};
		let posIdx = 0;
		for (const [argName, desc] of Object.entries(argDefs)) {
			if (desc.multiple) {
				const val = positionals.slice(posIdx);
				args[argName] = val.length > 0 ? val : undefined;
				posIdx = positionals.length;
			} else {
				const val = positionals[posIdx];
				args[argName] = val;
				posIdx++;
			}
			// Validate required
			if (desc.required && args[argName] === undefined) {
				throw new Error(`Missing required argument: ${argName}`);
			}
			// Validate options constraint
			const argVal = args[argName];
			if (argVal !== undefined && desc.options && typeof argVal === "string") {
				if (!desc.options.includes(argVal)) {
					throw new Error(`Expected ${argName} to be one of: ${[...desc.options].join(", ")}; got "${argVal}"`);
				}
			}
		}

		return { flags, args, argv: positionals } as never;
	}
}

// ---------------------------------------------------------------------------
// Help rendering
// ---------------------------------------------------------------------------

/** Render full root help: header, default command details, subcommand list. */
export function renderRootHelp(config: CliConfig): void {
	const { bin, version, commands } = config;
	const lines: string[] = [];
	lines.push(`${bin} v${version}\n`);
	lines.push("USAGE");
	lines.push(`  $ ${bin} [COMMAND]\n`);

	// Show the default command's flags/args/examples inline.
	// The default command is the one marked hidden (it's the implicit entry point).
	const defaultCmd = [...commands.values()].find(C => C.hidden);
	if (defaultCmd) {
		renderCommandBody(lines, defaultCmd);
	}

	// List visible subcommands
	const visible = [...commands.entries()].filter(([, C]) => !C.hidden);
	if (visible.length > 0) {
		lines.push("COMMANDS");
		const maxLen = Math.max(...visible.map(([n]) => n.length));
		for (const [name, C] of visible.sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`  ${name.padEnd(maxLen + 2)}${C.description ?? ""}`);
		}
		lines.push("");
	}

	process.stdout.write(lines.join("\n"));
}

/** Render help for a single command. */
export function renderCommandHelp(bin: string, id: string, Cmd: CommandCtor): void {
	const lines: string[] = [];
	if (Cmd.description) lines.push(`${Cmd.description}\n`);
	lines.push("USAGE");
	const argNames = Object.keys(Cmd.args ?? {});
	const argStr = argNames.length > 0 ? ` ${argNames.map(n => `[${n.toUpperCase()}]`).join(" ")}` : "";
	const hasFlags = Object.keys(Cmd.flags ?? {}).length > 0;
	lines.push(`  $ ${bin} ${id}${argStr}${hasFlags ? " [FLAGS]" : ""}\n`);
	renderCommandBody(lines, Cmd);
	process.stdout.write(lines.join("\n"));
}

function renderCommandBody(lines: string[], Cmd: CommandCtor): void {
	const argDefs = Cmd.args ?? {};
	const flagDefs = Cmd.flags ?? {};

	// Arguments
	const argEntries = Object.entries(argDefs);
	if (argEntries.length > 0) {
		lines.push("ARGUMENTS");
		const maxLen = Math.max(...argEntries.map(([n]) => n.length));
		for (const [name, desc] of argEntries) {
			const parts = [name.toUpperCase().padEnd(maxLen + 2)];
			if (desc.description) parts.push(desc.description);
			if (desc.options) parts.push(`(${[...desc.options].join("|")})`);
			lines.push(`  ${parts.join(" ")}`);
		}
		lines.push("");
	}

	// Flags
	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length > 0) {
		lines.push("FLAGS");
		const formatted: [string, string][] = [];
		for (const [name, desc] of flagEntries) {
			const charPart = desc.char ? `-${desc.char}, ` : "    ";
			const namePart = `--${name}`;
			const typePart = desc.kind === "boolean" ? "" : desc.kind === "integer" ? "=<int>" : "=<value>";
			formatted.push([`  ${charPart}${namePart}${typePart}`, desc.description ?? ""]);
		}
		const maxLeft = Math.max(...formatted.map(([l]) => l.length));
		for (const [left, right] of formatted) {
			lines.push(`${left.padEnd(maxLeft + 2)}${right}`);
		}
		lines.push("");
	}

	// Examples
	if (Cmd.examples && Cmd.examples.length > 0) {
		lines.push("EXAMPLES");
		for (const ex of Cmd.examples) {
			for (const line of ex.split("\n")) {
				lines.push(`  ${line}`);
			}
		}
		lines.push("");
	}
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** A lazily-loaded command: canonical name, loader, and optional aliases. */
export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	aliases?: string[];
}

export interface RunOptions {
	bin: string;
	version: string;
	argv: string[];
	commands: CommandEntry[];
	/** Custom help renderer. Receives fully-populated config. */
	help?: (config: CliConfig) => Promise<void> | void;
}

/** Find a command entry by exact name or alias. */
function findEntry(commands: CommandEntry[], id: string): CommandEntry | undefined {
	return commands.find(e => e.name === id) ?? commands.find(e => e.aliases?.includes(id));
}

/**
 * Main entry point — replaces `run()` from @oclif/core.
 *
 * Each command is explicitly registered with a lazy loader.
 * No filesystem scanning, no plugin system, no package.json reading.
 */
export async function run(opts: RunOptions): Promise<void> {
	const { bin, version, argv } = opts;

	const commandId = argv[0] ?? "";
	const commandArgv = argv.slice(1);

	// Top-level help
	if (commandId === "--help" || commandId === "-h" || commandId === "help" || commandId === "") {
		const config = await loadAllCommands(opts);
		if (opts.help) {
			await opts.help(config);
		} else {
			renderRootHelp(config);
		}
		return;
	}

	// Version
	if (commandId === "--version" || commandId === "-v") {
		process.stdout.write(`${bin}/${version}\n`);
		return;
	}

	// Per-command help. Commands with nested subcommands can opt into receiving
	// help flags themselves so `cmd subcommand --help` can render subcommand help.
	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		const entry = findEntry(opts.commands, commandId);
		if (!entry) {
			process.stderr.write(`Unknown command: ${commandId}\n`);
			return;
		}
		const Cmd = await entry.load();
		if (Cmd.delegateHelp) {
			const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
			const instance = new Cmd(commandArgv, config);
			await instance.run();
		} else {
			const config = await loadAllCommands(opts);
			renderCommandHelp(bin, entry.name, config.commands.get(entry.name) ?? Cmd);
		}
		return;
	}

	// Find command by name or alias
	const entry = findEntry(opts.commands, commandId);

	if (!entry) {
		process.stderr.write(`Error: command ${commandId} not found\n`);
		process.exitCode = 1;
		return;
	}

	const Cmd = await entry.load();
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(commandArgv, config);
	await instance.run();
}

/** Resolve all command loaders for help/alias display. */
async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const commands = new Map<string, CommandCtor>();
	const loaded = await Promise.all(opts.commands.map(async e => [e.name, await e.load()] as const));
	for (const [name, Cmd] of loaded) {
		commands.set(name, Cmd);
	}
	return { bin: opts.bin, version: opts.version, commands };
}
