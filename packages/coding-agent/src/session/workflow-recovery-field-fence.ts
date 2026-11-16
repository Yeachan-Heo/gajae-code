const OPEN = "<untrusted-content>\n";
const CLOSE = "\n</untrusted-content>";

export const RECOVERY_GOAL_ID_MAX = 240;
export const RECOVERY_SOURCE_HASH_MAX = 240;

function clipFlat(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	let out = "";
	for (let index = 0; index < value.length && out.length < maxLength; index++) {
		const code = value.charCodeAt(index);
		if (code === 13) {
			if (value.charCodeAt(index + 1) === 10) index++;
			out += " ";
			continue;
		}
		out += code === 10 ? " " : (value[index] ?? "");
	}
	return out;
}

/** Clip the raw text, then escape. The fence is applied after that cut and the escaped text is not clipped again. */
export function fenceClippedCompactionText(value: string, maxLength: number): string {
	const cap = Math.max(0, maxLength);
	const escaped = clipFlat(value, cap).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `${OPEN}${escaped}${CLOSE}`;
}
