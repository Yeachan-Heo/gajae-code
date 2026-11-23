import * as path from "node:path";

export class CommandError extends Error {
	constructor(
		public readonly exitStatus: number,
		message: string,
	) {
		super(message);
		this.name = "CommandError";
	}
}

export function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

export function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Anchor every `--input @file` value to the invocation cwd (#7562).
 *
 * Workflow entrypoints canonicalize their cwd to the physical root so state
 * identity is alias-independent, but a relative input path must still resolve
 * the way the user spelled it: from a symlinked cwd, `@../payload.json` names
 * the file beside the alias, not beside its physical target. Leading and
 * trailing whitespace is preserved so each reader keeps its own trimming rules.
 */
export function anchorInputFileArgs(args: readonly string[], invocationCwd: string): string[] {
	return args.map((arg, index) => {
		if (index === 0 || args[index - 1] !== "--input") return arg;
		const body = arg.trimStart();
		if (!body.startsWith("@")) return arg;
		return `${arg.slice(0, arg.length - body.length)}@${path.resolve(invocationCwd, body.slice(1))}`;
	});
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

export function assertSafePathComponent(value: string, label: string): void {
	if (!PATH_COMPONENT_RE.test(value) || value.includes("..")) {
		throw new CommandError(2, `invalid path component for --${label}: ${value}`);
	}
}
