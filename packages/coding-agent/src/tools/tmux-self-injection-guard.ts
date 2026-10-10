/**
 * Prevent agent-authored tmux input from being delivered to the agent pane.
 *
 * This check runs before bash spawns anything. It is intentionally limited to
 * tmux input verbs; inspection and control of another pane remain available.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const INPUT_VERBS = new Set(["send-keys", "paste-buffer", "send-prefix"]);
const SHELL_RUNNERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "busybox"]);
const COMMAND_WRAPPERS = new Set(["eval", "exec", "command", "builtin", "nohup", "time"]);
const ASSIGNMENT_AWARE_WRAPPERS = new Set(["env", "sudo"]); // Only these allow VAR=value at start
const CONTROL_WORDS = new Set(["then", "do", "else", "fi", "done", "esac"]);
const MAX_INDIRECTION_DEPTH = 4;

// Wrapper commands and their options that take an argument.
// These are used to properly skip over option arguments so the next word
// in command position is recognized as the actual command.
interface WrapperSpec {
	// Option flags that take exactly one argument (e.g., "-u NAME")
	optionsWithArg: Set<string>;
	// Flag-only options that do not consume the next argument (e.g., sudo "-s", "-i")
	flagOnlyOptions?: Set<string>;
	// Special positional argument handling (e.g., timeout takes a DURATION)
	hasPositionalArg?: boolean;
}

// Long options for bash/sh that take arguments (e.g., --rcfile FILE, --init-file FILE)
const SHELL_LONG_OPTIONS_WITH_ARG = new Set([
	"--rcfile", // bash --rcfile FILE
	"--init-file", // bash --init-file FILE (same as --rcfile)
]);

// Options that take arguments for long-option forms (e.g., env --unset=VAR, xargs --file=FILE)
const LONG_OPTIONS_WITH_ARG = new Set([
	"--unset", // env --unset VAR (takes variable name)
]);

// Per-wrapper long-option specifications
const WRAPPER_LONG_OPTIONS: Record<string, Record<string, boolean>> = {
	env: {
		"--unset": true, // env --unset=VAR or --unset VAR
		"--split-string": false, // env -S/--split-string (flag-only)
	},
	timeout: {
		"--signal": true, // timeout --signal=SIGNAL (takes signal name)
		"--kill-after": true, // timeout --kill-after=TIME
		"--preserve-status": false, // timeout --preserve-status (flag-only)
		"--verbose": false, // timeout --verbose (flag-only)
	},
	nice: {
		"--adjustment": true, // nice --adjustment=N (takes adjustment value)
	},
	stdbuf: {
		"--input": true, // stdbuf --input=MODE
		"--output": true, // stdbuf --output=MODE
		"--error": true, // stdbuf --error=MODE
	},
	xargs: {
		"--null": false, // xargs --null (flag-only)
		"--max-args": true, // xargs --max-args N
		"--arg-file": true, // xargs --arg-file FILE
		"--delimiter": true, // xargs --delimiter DELIM
		"--eof": true, // xargs --eof STRING
		"--max-procs": true, // xargs --max-procs N
		"--size": true, // xargs --size BYTES
		"--replace": false, // xargs --replace (flag-only, same as -I)
		"--verbose": false, // xargs --verbose (flag-only)
		"--no-run-if-empty": false, // xargs --no-run-if-empty (flag-only)
		"--exit": false, // xargs --exit (flag-only)
		"--null-input": false, // xargs --null-input (flag-only, same as -0)
	},
};

const COMMAND_WRAPPERS_WITH_ARGS: Record<string, WrapperSpec> = {
	env: {
		optionsWithArg: new Set(["-u", "-C", "-S"]),
	},
	sudo: {
		optionsWithArg: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
		flagOnlyOptions: new Set(["-s", "-i"]),
	},
	timeout: {
		optionsWithArg: new Set(["-s", "-k"]), // -s SIGNAL, -k KILL_SIGNAL; -v is flag-only
		flagOnlyOptions: new Set(["-v", "-p"]), // -v flag-only, -p flag-only
		hasPositionalArg: true, // timeout DURATION command
	},
	nice: {
		optionsWithArg: new Set(["-n"]),
	},
	xargs: {
		optionsWithArg: new Set(["-E", "-I", "-J", "-L", "-n", "-P", "-R", "-d", "-s", "-a"]), // -s SIZE, -a FILE
		flagOnlyOptions: new Set(["-t", "-x", "-0"]),
	},
	stdbuf: {
		optionsWithArg: new Set(["-i", "-o", "-e"]),
	},
	setsid: {
		optionsWithArg: new Set(),
		flagOnlyOptions: new Set(["-c", "-w"]),
	},
};

export interface TmuxSelfInjectionResult {
	block: boolean;
	reason?: string;
}

export type TmuxPaneResolver = (options: {
	socketArgs: string[];
	target: string;
	env: Record<string, string>;
}) => Promise<string | undefined>;

export interface TmuxSelfInjectionOptions {
	env?: Record<string, string | undefined>;
	cwd?: string;
	resolvePaneId?: TmuxPaneResolver;
}

interface Token {
	text: string;
	quoted: boolean;
	commandStart: boolean;
	isWrappedCommand?: boolean; // true if this token is the actual command being wrapped by a wrapper like 'command', 'env', 'sudo'
}

function isSeparator(ch: string): boolean {
	return ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "\n";
}

function isAssignment(text: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(text);
}

function isNegativeNumber(text: string): boolean {
	return /^-\d+/.test(text); // e.g., -5, -10, etc.
}

function isLongOption(text: string): boolean {
	return text.startsWith("--");
}

/** Small quote-aware lexer. Unknown shell syntax is represented conservatively. */
function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let text = "";
	let quoted = false;
	let quote: "'" | '"' | undefined;
	let atCommandStart = true;
	let wrapperCommand: { name: string; spec: WrapperSpec } | undefined;
	let skipNextArg = false;
	let positionalsPending = 0;

	const flush = () => {
		if (text.length === 0) return;

		let commandStart = atCommandStart;
		let isWrappedCommand = false;

		if (atCommandStart) {
			const newWrapper = COMMAND_WRAPPERS_WITH_ARGS[text];
			const isBuiltinWrapper = COMMAND_WRAPPERS.has(text);

			if (CONTROL_WORDS.has(text)) {
				// Control words reset wrapper state (but not if we're already in a wrapper)
				if (!wrapperCommand) {
					wrapperCommand = undefined;
					skipNextArg = false;
					positionalsPending = 0;
				}
				atCommandStart = true;
			} else if (isAssignment(text)) {
				// Assignments at command start
				if (!wrapperCommand) {
					// Not in a wrapper - this is a simple assignment at command start
					atCommandStart = true;
				}
				// If in a wrapper, keep wrapper active and don't change atCommandStart
			} else if (newWrapper) {
				// Track this wrapper for its arguments
				wrapperCommand = { name: text, spec: newWrapper };
				skipNextArg = false;
				positionalsPending = newWrapper.hasPositionalArg ? 1 : 0;
				atCommandStart = false; // Now in wrapper argument mode
			} else if (isBuiltinWrapper) {
				// Built-in wrappers
				wrapperCommand = { name: text, spec: { optionsWithArg: new Set() } };
				skipNextArg = false;
				positionalsPending = 0;
				atCommandStart = false; // Now in wrapper argument mode
			} else if (wrapperCommand) {
				// This is the command being wrapped - mark it as a command start
				wrapperCommand = undefined;
				skipNextArg = false;
				positionalsPending = 0;
				commandStart = true; // The wrapped command is a command start
				atCommandStart = false;
			} else {
				// Regular command
				atCommandStart = false;
			}
		} else {
			// Not at command start
			if (text.startsWith("-") && !isNegativeNumber(text)) {
				// This is an option (but not a negative number like -5)
				// Don't touch skipNextArg yet; it will be consumed by the next argument
			} else if (skipNextArg) {
				// This is an argument to an option (e.g., -n 5 or -n -5)
				// Skip it regardless of whether it looks like an option
				skipNextArg = false;
			} else if (positionalsPending > 0) {
				// This is a positional argument like timeout's DURATION
				positionalsPending--;
			} else if (isAssignment(text) && wrapperCommand && ASSIGNMENT_AWARE_WRAPPERS.has(wrapperCommand.name)) {
				// In assignment-aware wrappers (env, sudo), assignments are arguments
				// Keep wrapper mode active for nested wrappers like 'env sudo -E tmux ...'
				commandStart = false;
			} else if (isAssignment(text) && wrapperCommand && !ASSIGNMENT_AWARE_WRAPPERS.has(wrapperCommand.name)) {
				// In non-assignment-aware wrappers, VAR=value tries to be executed as a command
				// This means we've hit the end of the wrapper and found the wrapped command
				wrapperCommand = undefined;
				commandStart = true;
			} else if (wrapperCommand && !text.startsWith("-") && !isAssignment(text)) {
				// We're in a wrapper and this is not an option or assignment
				// Check if this is itself a wrapper (nested wrappers like 'env sudo')
				const nestedWrapper = COMMAND_WRAPPERS_WITH_ARGS[text];
				const isNestedBuiltinWrapper = COMMAND_WRAPPERS.has(text);

				if (nestedWrapper) {
					// Nested wrapper found - set it up as the new wrapper
					wrapperCommand = { name: text, spec: nestedWrapper };

					skipNextArg = false;
					positionalsPending = nestedWrapper.hasPositionalArg ? 1 : 0;
					commandStart = true; // The wrapper itself is still a command start
				} else if (isNestedBuiltinWrapper) {
					// Nested built-in wrapper found
					wrapperCommand = { name: text, spec: { optionsWithArg: new Set() } };
					skipNextArg = false;
					positionalsPending = 0;
					commandStart = true; // The wrapper itself is still a command start
				} else {
					// Not a wrapper - this is the final wrapped command
					wrapperCommand = undefined;
					skipNextArg = false;
					commandStart = true; // The wrapped command is a command start
					isWrappedCommand = true; // Track that this is a wrapped command
				}
			}
		}

		const token: Token = { text, quoted, commandStart, ...(isWrappedCommand && { isWrappedCommand }) };
		tokens.push(token);

		text = "";
		quoted = false;
	};

	for (let index = 0; index < command.length; index++) {
		const ch = command[index];
		if (quote !== undefined) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			if (quote === '"' && ch === "\\" && index + 1 < command.length) {
				text += command[++index];
				continue;
			}
			text += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			quoted = true;
			continue;
		}
		if (ch === "\\" && index + 1 < command.length) {
			text += command[++index];
			quoted = true;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (isSeparator(ch)) {
			flush();
			atCommandStart = true;
			wrapperCommand = undefined;
			skipNextArg = false;
			positionalsPending = 0;
			continue;
		}

		text += ch;

		// After building a token, check if it's an option that needs an argument
		// Skip negative numbers (e.g., -5 for nice -n -5)
		if (!atCommandStart && wrapperCommand && text.startsWith("-") && !isNegativeNumber(text)) {
			const nextChar = command[index + 1];
			if (!nextChar || /\s/.test(nextChar) || isSeparator(nextChar)) {
				// This option is complete; check if it takes an argument
				skipNextArg = false; // Reset default

				// Handle long options (--*)
				if (isLongOption(text)) {
					const baseLongOption = text.split("=")[0];
					const hasEqualValue = text.includes("=");

					// Check wrapper-specific long options
					const wrapperLongOpts = WRAPPER_LONG_OPTIONS[wrapperCommand.name];
					if (wrapperLongOpts) {
						if (baseLongOption in wrapperLongOpts) {
							const takesArg = wrapperLongOpts[baseLongOption];
							if (takesArg && !hasEqualValue) {
								skipNextArg = true; // Takes separate argument
							}
						} else if (LONG_OPTIONS_WITH_ARG.has(baseLongOption) && !hasEqualValue) {
							skipNextArg = true;
						}
					}
				} else {
					// Handle short options (including bundles like -iu)
					// Process each character in the bundle
					for (let i = 1; i < text.length; i++) {
						const opt = text[i];
						const shortOpt = "-" + opt;

						// Check if this short option takes an argument
						const isFlagOnly = wrapperCommand.spec.flagOnlyOptions?.has(shortOpt) ?? false;
						const takesArg = !isFlagOnly && wrapperCommand.spec.optionsWithArg.has(shortOpt);

						if (takesArg) {
							// If this is the last character in the bundle, the next arg is its operand
							if (i === text.length - 1) {
								skipNextArg = true;
							}
							break; // Stop processing further chars after an option with arg
						}
					}
				}
			}
		}
	}
	flush();
	return tokens;
}

interface Invocation {
	verb: string;
	args: string[];
	socketArgs: string[];
	socket?: { flag: "-L" | "-S"; value: string };
}

function parseInvocation(tokens: Token[]): Invocation | undefined {
	let index = 0;
	const socketArgs: string[] = [];
	let socket: Invocation["socket"];
	while (index < tokens.length && !tokens[index].commandStart) {
		const option = tokens[index].text;
		if (option === "--") {
			index++;
			break;
		}
		if (option === "-L" || option === "-S") {
			const value = tokens[index + 1];
			if (!value || value.commandStart) return undefined;
			socket = { flag: option, value: value.text };
			socketArgs.push(option, value.text);
			index += 2;
			continue;
		}
		if (option.startsWith("-L") || option.startsWith("-S")) {
			const flag = option.slice(0, 2) as "-L" | "-S";
			const value = option.slice(2);
			if (!value) return undefined;
			socket = { flag, value };
			socketArgs.push(flag, value);
			index++;
			continue;
		}
		if (option.startsWith("-")) {
			index++;
			continue;
		}
		break;
	}
	const verb = tokens[index];
	if (!verb || verb.commandStart) return undefined;
	const args: string[] = [];
	for (index++; index < tokens.length && !tokens[index].commandStart; index++) args.push(tokens[index].text);
	return { verb: verb.text, args, socketArgs, socket };
}

function targetFromArgs(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-t") return args[index + 1];
		if (args[index].startsWith("-t") && args[index].length > 2) return args[index].slice(2);
	}
	return undefined;
}

function collectShellPayloads(tokens: Token[]): string[] {
	const payloads: string[] = [];
	// Options that take an argument for bash/sh/similar shells
	const optionsWithArg = new Set(["-O", "-o"]); // bash -O extglob, bash -o pipefail, etc.

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.commandStart) continue;

		// Check if this is a shell runner or busybox
		let shellIndex = index;
		if (token.text === "busybox") {
			// For busybox, the next non-option token is the applet name
			// Check if it's a shell applet
			for (let cursor = index + 1; cursor < tokens.length && !tokens[cursor].commandStart; cursor++) {
				const arg = tokens[cursor].text;
				if (arg.startsWith("-")) continue; // Skip busybox options
				// This is the applet name
				if (SHELL_RUNNERS.has(arg)) {
					// The applet is a shell, so we should scan from here
					shellIndex = cursor;
				}
				break;
			}
		}

		if (!SHELL_RUNNERS.has(tokens[shellIndex].text)) continue;

		// Scan for -c options in the shell invocation.
		// Look for patterns like:
		// - bash -c 'payload'
		// - bash -ce 'payload' (bundled option)
		// - bash -c -e 'payload' (separate options)
		// - bash -O extglob -c 'payload' (shopt with operand)
		// - bash -o pipefail -c 'payload' (shopt with operand)
		// - bash --rcfile FILE -c 'payload' (long option with argument)
		// - bash --norc -c 'payload' (long option without argument)
		// POSIX shells stop option parsing at the first non-option argument,
		// so after we see a non-option word (script name), any flags are arguments to that script.

		let skipNextArg = false;

		for (let cursor = shellIndex + 1; cursor < tokens.length && !tokens[cursor].commandStart; cursor++) {
			const word = tokens[cursor].text;

			// If the previous option takes an argument, skip this word
			if (skipNextArg) {
				skipNextArg = false;
				continue;
			}

			// Once we see a non-option word (not starting with -), that's the script name.
			// Any further flags are arguments to that script, not shell options.
			if (!word.startsWith("-")) {
				break; // Stop scanning for -c after the first operand
			}

			// Check if this is a long option
			if (word.startsWith("--")) {
				// Handle long options with = (e.g., --rcfile=FILE)
				if (word.includes("=")) {
					skipNextArg = false;
					continue;
				}
				// Handle long options that take an argument
				if (SHELL_LONG_OPTIONS_WITH_ARG.has(word)) {
					skipNextArg = true;
					continue;
				}
				// All other long options are flag-only (e.g., --norc, --noprofile)
				continue;
			}

			// Check if this option takes an argument (e.g., -O, -o for bash)
			if (optionsWithArg.has(word)) {
				skipNextArg = true;
				continue;
			}

			// Handle options with bundled operands (e.g., -Oextglob, -opipefail)
			if ((word.startsWith("-O") && word.length > 2) || (word.startsWith("-o") && word.length > 2)) {
				// The operand is bundled with the option, so skip this and check the next word for -c
				continue;
			}

			// Check for -c option (standalone or bundled like -ce, -ec, etc.)
			if (word === "-c" || (word.startsWith("-") && word.includes("c"))) {
				// Found a -c option (or an option containing c)
				// The command string is the first non-option word after -c, regardless of quoting
				for (
					let payloadCursor = cursor + 1;
					payloadCursor < tokens.length && !tokens[payloadCursor].commandStart;
					payloadCursor++
				) {
					const payloadToken = tokens[payloadCursor];
					const payloadWord = payloadToken.text;

					// Skip over any remaining shell options or their arguments
					// But don't skip quoted strings, even if they start with -
					if (payloadWord.startsWith("-") && !payloadToken.quoted) {
						// Check if this option takes an argument
						if (optionsWithArg.has(payloadWord)) {
							payloadCursor++; // Skip the argument
						}
						// Handle options with bundled operands (e.g., -Oextglob)
						if (
							(payloadWord.startsWith("-O") && payloadWord.length > 2) ||
							(payloadWord.startsWith("-o") && payloadWord.length > 2)
						) {
							// The operand is bundled with the option, no need to skip
						}
						continue;
					}

					// Found the first non-option word after -c; this is the actual command string
					// Add it regardless of quoting, because bash will execute it as the command
					payloads.push(payloadWord);
					break; // Only take the first payload for this -c
				}
				break; // -c stops option parsing
			}
		}
	}

	// Handle env -S/--split-string payloads
	// env -S 'payload' splits the string and executes the result
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.commandStart || (token.text !== "env" && !token.text.endsWith("/env"))) continue;

		// Look for -S or --split-string option
		let inEnv = true;
		for (let cursor = index + 1; cursor < tokens.length && !tokens[cursor].commandStart && inEnv; cursor++) {
			const arg = tokens[cursor].text;

			// Stop at the first non-option, non-assignment
			if (!arg.startsWith("-") && !isAssignment(arg)) {
				inEnv = false;
				break;
			}

			// Check for -S option (standalone)
			if (arg === "-S") {
				// The next argument is the split-string payload
				if (cursor + 1 < tokens.length && !tokens[cursor + 1].commandStart) {
					const payload = tokens[cursor + 1].text;
					// env -S splits the string into arguments, which become the executed command
					payloads.push(payload);
					cursor++; // Skip the payload we just processed
				}
			}
			// Check for --split-string option (with or without =)
			else if (arg.startsWith("--split-string")) {
				if (arg.includes("=")) {
					// Handle --split-string=value format
					const value = arg.split("=", 2)[1];
					if (value) {
						payloads.push(value);
					}
				} else if (arg === "--split-string") {
					// Handle --split-string value format (separate argument)
					if (cursor + 1 < tokens.length && !tokens[cursor + 1].commandStart) {
						const payload = tokens[cursor + 1].text;
						payloads.push(payload);
						cursor++; // Skip the payload we just processed
					}
				}
			}
		}
	}

	return payloads;
}

function collectShellScripts(tokens: Token[], cwd: string): string[] {
	const scripts: string[] = [];
	const optionsWithArg = new Set(["-O", "-o"]); // bash -O extglob, bash -o pipefail, etc.

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.commandStart && (token.text.startsWith("./") || token.text.startsWith("/"))) {
			scripts.push(path.resolve(cwd, token.text));
			continue;
		}
		if (!token.commandStart) continue;

		// Handle shell runners (bash, sh, etc.) and busybox applets
		let shellIndex = index;
		if (token.text === "busybox") {
			// For busybox, find the applet name
			for (let cursor = index + 1; cursor < tokens.length && !tokens[cursor].commandStart; cursor++) {
				const arg = tokens[cursor].text;
				if (arg.startsWith("-")) continue; // Skip busybox options
				// This is the applet name
				if (SHELL_RUNNERS.has(arg)) {
					shellIndex = cursor;
				}
				break;
			}
		}

		if (!SHELL_RUNNERS.has(tokens[shellIndex].text)) continue;

		// Skip past all options (short, long, and their arguments) to find the script argument
		let skipNextArg = false;
		for (let cursor = shellIndex + 1; cursor < tokens.length && !tokens[cursor].commandStart; cursor++) {
			const argument = tokens[cursor].text;

			// If the previous option takes an argument, skip this word
			if (skipNextArg) {
				skipNextArg = false;
				continue;
			}

			// If we encounter -c, stop looking (script mode is not used)
			if (argument === "-c") break;

			// Skip options and their arguments
			if (argument.startsWith("-")) {
				// Check if this is a long option
				if (argument.startsWith("--")) {
					// Handle long options with = (e.g., --rcfile=FILE)
					if (argument.includes("=")) {
						skipNextArg = false;
						continue;
					}
					// Handle long options that take an argument
					if (SHELL_LONG_OPTIONS_WITH_ARG.has(argument)) {
						skipNextArg = true;
						continue;
					}
					// All other long options are flag-only
					continue;
				}

				// Check if this short option takes an argument
				if (optionsWithArg.has(argument)) {
					skipNextArg = true;
					continue;
				}

				// Handle options with bundled operands (e.g., -Oextglob, -opipefail)
				if (
					(argument.startsWith("-O") && argument.length > 2) ||
					(argument.startsWith("-o") && argument.length > 2)
				) {
					continue;
				}

				continue; // Skip all other options
			}

			// Found the first non-option word; this is the script name
			scripts.push(path.resolve(cwd, argument));
			break;
		}
	}
	return scripts;
}

interface Identity {
	socketPath: string;
	paneId: string;
}

function currentIdentity(env: Record<string, string | undefined>): Identity | undefined {
	const tmux = env.TMUX;
	const paneId = env.TMUX_PANE;
	const socketPath = tmux?.split(",")[0];
	return socketPath && paneId ? { socketPath, paneId } : undefined;
}

function socketPathFor(
	socket: NonNullable<Invocation["socket"]>,
	env: Record<string, string | undefined>,
	cwd: string,
	uid: number,
): string {
	if (socket.flag === "-S") return path.isAbsolute(socket.value) ? socket.value : path.resolve(cwd, socket.value);
	return path.join(env.TMUX_TMPDIR ?? "/tmp", `tmux-${uid}`, socket.value);
}

function sameSocket(left: string, right: string): boolean {
	if (left === right) return true;
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return false;
	}
}

function assignedTmuxSocket(tokens: Token[], commandIndex: number): string | undefined {
	// Backtrack from the command position to find any TMUX assignment
	// Only look for assignments that are arguments to wrappers, or at the command start
	// Stop at the first commandStart token (which marks an invocation boundary from a separator like ;)
	let firstWrapperIndex = -1;
	for (let index = commandIndex - 1; index >= 0 && commandIndex - index <= 20; index++) {
		const token = tokens[index];

		// Check for TMUX assignment
		const assignment = token.text.match(/^TMUX=([^,\s]+)/);
		if (assignment) {
			// Only return the assignment if it's within the same invocation
			// (before any command boundary marked by commandStart)
			if (firstWrapperIndex === -1 || index > firstWrapperIndex) {
				return assignment[1];
			}
		}

		// Track command boundaries
		if (token.commandStart) {
			if (!COMMAND_WRAPPERS.has(token.text) && !COMMAND_WRAPPERS_WITH_ARGS[token.text]) {
				// Hit a non-wrapper command start; this marks the boundary of a previous invocation
				// Stop searching - assignments found here belong to a different command
				break;
			}
			// Track the first wrapper we encounter while backtracking
			if (firstWrapperIndex === -1) {
				firstWrapperIndex = index;
			}
		}
	}
	return undefined;
}

/**
 * Check if the given index is part of a `command -v` or `command -V` lookup.
 * Such invocations are not executions, so tmux commands within them don't run.
 * The target token must be the actual command being looked up, not a subsequent command after a separator.
 */
function isCommandLookup(tokens: Token[], targetIndex: number): boolean {
	// Backtrack through all tokens to find if we're in a `command -v` sequence
	// Look for the pattern: command -v/V TARGET, where TARGET is the direct command being looked up
	for (let commandIdx = 0; commandIdx < targetIndex; commandIdx++) {
		if (!tokens[commandIdx].commandStart || tokens[commandIdx].text !== "command") {
			continue;
		}

		// Found a "command" token, look for -v or -V after it (standalone or bundled)
		let lookupFlagIdx = -1;
		for (let i = commandIdx + 1; i < targetIndex; i++) {
			const token = tokens[i].text;
			// Check for -v/-V standalone or bundled in short options (e.g., -pv)
			if (
				token === "-v" ||
				token === "-V" ||
				(token.startsWith("-") && !token.startsWith("--") && (token.includes("v") || token.includes("V")))
			) {
				lookupFlagIdx = i;
				break;
			}
		}

		// If we found the lookup flag, check if the target is the next non-option word
		// within the same command (not after a command boundary)
		if (lookupFlagIdx >= 0) {
			// Check if there's a command boundary (commandStart token) between the lookup flag and target
			let hasCommandBoundary = false;
			for (let sep = lookupFlagIdx + 1; sep < targetIndex; sep++) {
				if (tokens[sep].commandStart) {
					hasCommandBoundary = true;
					break;
				}
			}
			if (hasCommandBoundary) {
				// Target is after a command boundary, so it's not part of the lookup
				continue;
			}

			// Find the wrapped command (first non-option, non-assignment after the lookup flag)
			for (let i = lookupFlagIdx + 1; i < tokens.length; i++) {
				const word = tokens[i].text;
				// Skip options and assignments
				if (word.startsWith("-") || isAssignment(word)) {
					continue;
				}
				// If the first non-option word has commandStart=true but is NOT a wrapped command,
				// it's a new command after a separator, not an operand of the lookup.
				// This handles empty lookups like `command -v; tmux send-keys`
				if (tokens[i].commandStart && !tokens[i].isWrappedCommand) {
					break;
				}
				// This is the operand of the lookup; check if it matches the target
				return i === targetIndex;
			}
		}
	}

	return false;
}

const defaultResolvePaneId: TmuxPaneResolver = async ({ socketArgs, target, env }) => {
	const processHandle = Bun.spawn(["tmux", ...socketArgs, "display-message", "-p", "-t", target, "#{pane_id}"], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const killTimer = setTimeout(() => processHandle.kill(), 2_000);
	try {
		const output = await new Response(processHandle.stdout).text();
		await processHandle.exited;
		const paneId = output.trim().split("\n")[0];
		return paneId?.startsWith("%") ? paneId : undefined;
	} finally {
		clearTimeout(killTimer);
	}
};

export async function checkTmuxSelfInjection(
	command: string,
	options: TmuxSelfInjectionOptions = {},
	depth = 0,
): Promise<TmuxSelfInjectionResult> {
	const env = options.env ?? process.env;
	const identity = currentIdentity(env);
	if (!identity) return { block: false };
	const cwd = options.cwd ?? env.PWD ?? ".";
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const resolvePaneId = options.resolvePaneId ?? defaultResolvePaneId;
	const tokens = tokenize(command);

	for (let index = 0; index < tokens.length; index++) {
		if (!tokens[index].commandStart || (tokens[index].text !== "tmux" && !tokens[index].text.endsWith("/tmux")))
			continue;
		// Skip tmux invocations that are part of a `command -v` lookup (not execution)
		if (isCommandLookup(tokens, index)) continue;
		const invocation = parseInvocation(tokens.slice(index + 1));
		if (!invocation || !INPUT_VERBS.has(invocation.verb)) continue;
		const assignedSocket = assignedTmuxSocket(tokens, index);
		const commandSocket = invocation.socket ? socketPathFor(invocation.socket, env, cwd, uid) : assignedSocket;
		if (commandSocket && !sameSocket(commandSocket, identity.socketPath)) continue;

		const target = targetFromArgs(invocation.args);
		if (target === undefined) {
			return {
				block: true,
				reason: `Blocked: ${invocation.verb} without a target would inject keystrokes into this agent pane (${identity.paneId}).`,
			};
		}
		if (target === identity.paneId) {
			return {
				block: true,
				reason: `Blocked: ${invocation.verb} targets this agent pane (${identity.paneId}); injected bytes would become a forged user turn.`,
			};
		}
		if (!target.startsWith("%")) {
			const resolved = await resolvePaneId({
				socketArgs: invocation.socketArgs,
				target,
				env: { ...env, TMUX: `${identity.socketPath},0,0` } as Record<string, string>,
			});
			if (resolved !== undefined && resolved !== identity.paneId) continue;
			if (resolved === identity.paneId || resolved === undefined) {
				return {
					block: true,
					reason:
						resolved === identity.paneId
							? `Blocked: ${invocation.verb} target ${target} resolves to this agent pane (${identity.paneId}); injected bytes would become a forged user turn.`
							: `Blocked: could not verify that ${invocation.verb} target ${target} is a different pane on the current tmux server; refusing fail-closed.`,
				};
			}
		}
	}

	if (depth < MAX_INDIRECTION_DEPTH) {
		for (const payload of collectShellPayloads(tokens)) {
			const result = await checkTmuxSelfInjection(payload, options, depth + 1);
			if (result.block) return result;
		}
		for (const scriptPath of collectShellScripts(tokens, cwd)) {
			try {
				const file = Bun.file(scriptPath);
				if (!(await file.exists()) || file.size > 1_000_000) continue;
				const script = await file.text();
				const result = await checkTmuxSelfInjection(script, options, depth + 1);
				if (result.block) return result;
			} catch {
				// An unreadable or missing script is not itself evidence that it
				// targets this pane; let the shell report the normal file error.
			}
		}
	}
	return { block: false };
}
