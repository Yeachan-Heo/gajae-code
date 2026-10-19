/**
 * Keep a subagent role body inside the host [ROLE] block.
 *
 * The body is the agent instruction. It is inserted between host [ROLE] and
 * [/ROLE]. A literal framing tag would end that block early. Only the four
 * host framing names are rewritten; other brackets stay literal.
 *
 * One left-to-right scan: a gap run, a slash only when it is present, then
 * one more gap run, then the word. A non-matching "[" does not hide a later tag.
 */

const WORDS = ["completion", "context", "role", "coop"] as const;

function isGap(code: number): boolean {
	return (
		code === 0x09 ||
		code === 0x0a ||
		code === 0x0b ||
		code === 0x0c ||
		code === 0x0d ||
		code === 0x20 ||
		code === 0xa0 ||
		code === 0x200b ||
		code === 0x200c ||
		code === 0x200d ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

function wordLengthAt(body: string, index: number): number {
	const slice = body.slice(index, index + 10).toLowerCase();
	for (const word of WORDS) {
		if (!slice.startsWith(word)) continue;
		const after = body.charCodeAt(index + word.length);
		if (Number.isNaN(after) || isGap(after) || after === 0x5d) return word.length;
	}
	return 0;
}

/** End index of a framing tag starting at "[", or -1. */
function framingTagEnd(body: string, start: number): number {
	let index = start + 1;
	while (index < body.length && isGap(body.charCodeAt(index))) index++;
	if (body.charCodeAt(index) === 0x2f) {
		index++;
		while (index < body.length && isGap(body.charCodeAt(index))) index++;
	}
	const wordLength = wordLengthAt(body, index);
	if (wordLength === 0) return -1;
	index += wordLength;
	while (index < body.length && isGap(body.charCodeAt(index))) index++;
	return body.charCodeAt(index) === 0x5d ? index + 1 : -1;
}

export function containSubagentRoleBody(body: string): string {
	const parts: string[] = [];
	let plainStart = 0;
	let index = 0;
	while (index < body.length) {
		if (body.charCodeAt(index) !== 0x5b) {
			index++;
			continue;
		}
		const end = framingTagEnd(body, index);
		if (end < 0) {
			index++;
			continue;
		}
		if (plainStart < index) parts.push(body.slice(plainStart, index));
		parts.push(body.slice(index, end).replaceAll("[", "［").replaceAll("]", "］"));
		index = end;
		plainStart = index;
	}
	if (plainStart === 0) return body;
	if (plainStart < body.length) parts.push(body.slice(plainStart));
	return parts.join("");
}
