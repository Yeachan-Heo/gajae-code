export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports $1, $2, ... for positional args, $@ and $ARGUMENTS for all args
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$@\[(\d+)(?::(\d*)?)?\]|\$ARGUMENTS|\$@|\$(\d+)/g,
		(_, startRaw: string | undefined, lengthRaw: string | undefined, positionRaw: string | undefined) => {
			if (positionRaw !== undefined) {
				return args[Number.parseInt(positionRaw, 10) - 1] ?? "";
			}
			if (startRaw === undefined) return allArgs;

			const start = Number.parseInt(startRaw, 10);
			if (!Number.isFinite(start) || start < 1) return "";
			const startIndex = start - 1;
			if (startIndex >= args.length) return "";

			if (lengthRaw === undefined || lengthRaw === "") {
				return args.slice(startIndex).join(" ");
			}

			const length = Number.parseInt(lengthRaw, 10);
			if (!Number.isFinite(length) || length <= 0) return "";
			return args.slice(startIndex, startIndex + length).join(" ");
		},
	);
}
