import { describe, expect, it } from "bun:test";
import { findUnnecessaryUnicodeEscape } from "@gajae-code/ai/utils/json-parse";

// #4881: a Windows profile whose username is non-ASCII (C:\Users\최재필) puts
// Hangul into the machine's shortest home path, so escaping fires on routine
// tool calls that never chose non-ASCII content. These fixtures pin the
// detector contract for the shapes that actually occur on such a host:
// backslash drive paths, forward-slash variants, `ls -l` owner-column output,
// and cp949 mojibake from tools that decoded the path with the wrong code page.

const USER = "최재필";

/** Escapes every non-ASCII character as `\uXXXX`, the wire defect under test. */
function escapeAll(s: string): string {
	return s.replace(/[^\x00-\x7F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The exact username as it appears in `\uXXXX` form on the wire. */
const USER_ESCAPED = escapeAll(USER);

describe("findUnnecessaryUnicodeEscape — Windows non-ASCII home paths (#4881)", () => {
	it("accepts every literal-UTF-8 Windows home shape the model should emit", () => {
		// The detector must stay silent on the correct spelling: a non-ASCII
		// home is not itself a defect, only its escaped serialization is.
		const literalFixtures = [
			JSON.stringify({ path: `C:\\Users\\${USER}\\.bun\\install\\cache\\x.tgz` }),
			JSON.stringify({ path: `C:/Users/${USER}/AppData/Roaming/uv/cache` }),
			JSON.stringify({ command: `ls -l "C:\\Users\\${USER}"` }),
			JSON.stringify({ cwd: `D:\\DevProjects\\qlibx`, content: `const s = "${USER}";` }),
		];
		for (const payload of literalFixtures) {
			expect(findUnnecessaryUnicodeEscape(payload)).toBeUndefined();
		}
	});

	it("flags the escaped spelling of a backslash Windows home path", () => {
		// Backslashes are JSON-escaped (`\\`) independently of the Hangul; the
		// scanner must track both state machines at once and still name the
		// first unnecessary escape — the first syllable of the username.
		const payload = escapeAll(JSON.stringify({ path: `C:\\Users\\${USER}\\.bun\\x.ts` }));
		expect(findUnnecessaryUnicodeEscape(payload)).toBe(USER_ESCAPED.slice(0, 6));
	});

	it("flags the escaped spelling of a forward-slash Windows home path", () => {
		const payload = escapeAll(JSON.stringify({ path: `C:/Users/${USER}/.bun/x.ts` }));
		expect(findUnnecessaryUnicodeEscape(payload)).toBe(USER_ESCAPED.slice(0, 6));
	});

	it("flags escaped Hangul arriving through `ls -l` owner-column output", () => {
		// `ls -l` on this profile prints the username in every owner column,
		// so the defect can ride a command's *output* path back into a later
		// tool call even when the call's own arguments were ASCII.
		const output = `-rw-r--r-- 1 ${USER} ${USER} 4096 Aug 20 23:17 qlibx`;
		const payload = escapeAll(JSON.stringify({ command: `grep -l "sharpe" /tmp/out.txt`, content: output }));
		expect(findUnnecessaryUnicodeEscape(payload)).toBe(USER_ESCAPED.slice(0, 6));
	});

	it("flags escaped cp949 mojibake bytes, and does not flag them when literal", () => {
		// Python tracebacks on this host arrive as cp949-decoded mojibake
		// (`?\x1a\AppData\Roaming\uv\...` style lead/trail bytes landing in
		// Latin-1/PUA code points). Escaped, they are still an unnecessary
		// escape of a printable non-ASCII character; literal, they pass.
		const mojibake = "��\\AppData\\Roaming\\uv\\cache";
		const escapedPayload = escapeAll(JSON.stringify({ content: mojibake }));
		expect(findUnnecessaryUnicodeEscape(escapedPayload)).toBeDefined();
		expect(findUnnecessaryUnicodeEscape(JSON.stringify({ content: mojibake }))).toBeUndefined();
	});

	it("never flags the `\\\\uXXXX` source syntax of code that intentionally escapes", () => {
		// Writing an escaper that *should* emit `\uXXXX` (a code generator, a
		// fixture builder) is correct spelling, not a defect: the backslash is
		// itself escaped, so the scanner must not see an escape at all. This is
		// the false-positive boundary that makes structural Windows-path
		// triggering survivable rather than constant.
		const payload = JSON.stringify({ content: `const USER_ESCAPED = "\\u${USER.charCodeAt(0).toString(16)}";` });
		expect(findUnnecessaryUnicodeEscape(payload)).toBeUndefined();
	});

	it("flags an escaped Hangul payload only once — the reported span is the first escape", () => {
		const payload = escapeAll(JSON.stringify({ path: `C:\\Users\\${USER}\\권한\\설정.json` }));
		const hit = findUnnecessaryUnicodeEscape(payload);
		expect(hit).toBe(USER_ESCAPED.slice(0, 6));
		// The reported hit is a prefix of the full escaped username, and the
		// full escaped username is present verbatim in the payload.
		expect(payload).toContain(USER_ESCAPED);
		expect(USER_ESCAPED.startsWith(hit ?? "")).toBe(true);
	});
});
