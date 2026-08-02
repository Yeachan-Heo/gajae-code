import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Windows 콘솔 창 누출 회귀 방지.
 *
 * Windows 에서 powershell/cmd/git/gh 같은 콘솔 애플리케이션을 스폰할 때
 * `windowsHide: true` 가 빠지면 CREATE_NO_WINDOW 가 걸리지 않아 호출마다
 * 실제 콘솔 창이 뜬다. 부모가 콘솔 없는 데몬(브로커·알림·telegram)일 때 특히 그렇다.
 *
 * Bun 의 windowsHide 는 손자 프로세스로 전파되지 않으므로 스폰 지점마다
 * 개별로 걸어야 한다. 그래서 한 번 고쳐도 새 코드에서 쉽게 재발한다.
 *
 * 2026-08-02 실측(Windows 11, GJC 세션 8개): 30초에 conhost 46개 + WindowsTerminal 6개가
 * 생성됐고, 관측된 커맨드라인은 sdk/broker/process-incarnation.ts 가 만드는
 * `powershell.exe -NoLogo -NoProfile -NonInteractive -Command ...` 였다.
 */

const SRC_ROOT = join(import.meta.dir, "..", "src");

/** 실행 파일 이름이 리터럴로 확정되는 콘솔 애플리케이션. */
const CONSOLE_EXECUTABLE =
	/"(powershell(?:\.exe)?|pwsh|cmd(?:\.exe)?|git|gh|tmux|wmic|tasklist|taskkill|schtasks)"/;

const SPAWN_CALL = /\b(?:Bun\.spawn(?:Sync)?|spawnSync|execFile)\s*\(/g;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			collectSourceFiles(full, out);
			continue;
		}
		if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
		if (entry.includes(".test.") || entry.includes(".spec.")) continue;
		if (entry.endsWith(".generated.ts")) continue;
		out.push(full);
	}
	return out;
}

/** 스폰 호출의 괄호 범위를 반환한다. 닫히지 않으면 undefined. */
function callRange(source: string, openParenIndex: number): { start: number; end: number } | undefined {
	let depth = 0;
	for (let i = openParenIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return { start: openParenIndex, end: i };
		}
	}
	return undefined;
}

describe("windows console hide", () => {
	it("콘솔 애플리케이션을 스폰하는 런타임 코드는 windowsHide 를 지정한다", () => {
		const offenders: string[] = [];

		for (const file of collectSourceFiles(SRC_ROOT)) {
			const source = readFileSync(file, "utf8");
			SPAWN_CALL.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = SPAWN_CALL.exec(source)) !== null) {
				const range = callRange(source, match.index + match[0].length - 1);
				if (!range) continue;
				const block = source.slice(range.start, range.end + 1);
				if (!CONSOLE_EXECUTABLE.test(block)) continue;
				if (block.includes("windowsHide")) continue;
				const line = source.slice(0, match.index).split("\n").length;
				offenders.push(`${file.slice(SRC_ROOT.length + 1)}:${line}`);
			}
		}

		expect(offenders).toEqual([]);
	});
});
