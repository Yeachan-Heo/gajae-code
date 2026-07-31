/** Escape a string for interpolation inside a double- or single-quoted XML attribute. */
export function escapeXmlAttribute(input: string): string {
	if (!/[&<>"']/.test(input)) return input;
	let output = "";
	for (const char of input) {
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else if (char === "'") output += "&apos;";
		else output += char;
	}
	return output;
}
