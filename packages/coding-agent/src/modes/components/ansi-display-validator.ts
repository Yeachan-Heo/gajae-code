/** Removes every terminal control sequence except bounded SGR parameters (0-255). */
export function validateDisplayLine(line: string): string {
	let result = "";
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		const code = char.charCodeAt(0);
		if (char === "\t") {
			result += "    ";
			continue;
		}
		if (char === "\x1b") {
			const next = line[index + 1];
			if (next === "[") {
				const match = /^\x1b\[([0-9]{1,3}(?:;[0-9]{1,3})*)m/.exec(line.slice(index));
				if (match && match[0].length <= 64 && match[1]!.split(";").every(parameter => Number(parameter) <= 255)) {
					result += match[0];
					index += match[0].length - 1;
					continue;
				}
				index = skipEscapeSequence(line, index + 2, /[@-~]/);
				continue;
			}
			if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
				index = skipStringControl(line, index + 2);
				continue;
			}
			if (next === "_") {
				index = skipStringControl(line, index + 2);
				continue;
			}
			index += next ? 1 : 0;
			continue;
		}
		if (code >= 0x80 && code <= 0x9f) continue;
		if (code < 0x20 || code === 0x7f) continue;
		result += char;
	}
	return result;
}

function skipEscapeSequence(text: string, start: number, final: RegExp): number {
	for (let index = start; index < text.length; index++) {
		if (final.test(text[index]!)) return index;
	}
	return text.length - 1;
}

function skipStringControl(text: string, start: number): number {
	for (let index = start; index < text.length; index++) {
		if (text[index] === "\x07") return index;
		if (text[index] === "\x1b" && text[index + 1] === "\\") return index + 1;
	}
	return text.length - 1;
}
