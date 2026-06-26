import { describe, expect, it } from "bun:test";
import {
	COMPOSER_BASH_POLICY_ERROR,
	checkComposerBashPolicy,
	isComposerBashPolicyModel,
} from "../../src/tools/composer-bash-policy";

const COMPOSER_MODEL = "grok-build/grok-composer-2.5-fast";
const NON_COMPOSER_MODEL = "openai-codex/gpt-5.5";

describe("composer bash policy", () => {
	it("matches only composer harness models", () => {
		expect(isComposerBashPolicyModel("xai/grok-composer-2.5-fast")).toBe(true);
		expect(isComposerBashPolicyModel("cursor/composer2.5-fast")).toBe(true);
		expect(isComposerBashPolicyModel("gpt-5.5")).toBe(false);
		expect(isComposerBashPolicyModel("decomposer-2.5")).toBe(false);
	});

	it.each([
		"cat src/secret.ts",
		"/bin/cat src/secret.ts",
		"'cat' src/file.ts",
		'"cat" src/file.ts',
		"c\\at src/file.ts",
		"head -n 20 src/file.ts",
		"sed -n '1,20p' src/file.ts",
		"awk '{print}' src/file.ts",
		"grep -R needle src",
		"rg needle src",
		"find src -name '*.ts'",
		"fd target src",
		"tree src",
		"ls src",
		"git ls-files '*.ts'",
		"git cat-file -p HEAD:src/file.ts",
		"git show --name-only HEAD",
		"git show --stat HEAD",
		"git grep needle",
		"git --no-pager grep needle",
		"git -c core.pager=cat show HEAD:src/file.ts",
		"git --git-dir=.git ls-files",
		"git show HEAD:src/file.ts",
		"git diff",
		"git log --name-only -1",
		"cp src/a.ts src/b.ts",
		"mv src/a.ts src/b.ts",
		"rm src/a.ts",
		"touch src/new.ts",
		"mkdir src/newdir",
		"chmod 644 src/a.ts",
		"chown user src/a.ts",
		"python -c \"open('src/file.ts').read()\"",
		"python -c \"from pathlib import Path; Path('src/file.ts').read_bytes()\"",
		"python -c \"import os; print(os.listdir('src'))\"",
		"python -c \"from pathlib import Path; print(list(Path('src').iterdir()))\"",
		"python -c \"import os; print(list(os.scandir('src')))\"",
		"python -c \"from pathlib import Path; Path('src/file.ts').unlink()\"",
		"python -c \"import shutil; shutil.copyfile('a','b')\"",
		"node --input-type=module -e \"import fs from 'node:fs'; fs.readdirSync('src')\"",
		"node -e \"require('fs').readdirSync('src')\"",
		"node -e \"require('fs').statSync('src/file.ts')\"",
		"node -e \"require('fs').rmSync('src/file.ts')\"",
		"node -e \"require('fs').writeFileSync('x','y')\"",
		"bun -e \"await Bun.file('x').text()\"",
		"printf x > src/file.ts",
		"printf x | tee src/file.ts",
		"cat <(printf x)",
		"python - <<'PY'\nfrom pathlib import Path\nPath('x').read_text()\nPY",
		"I will now run bun test packages/coding-agent/test/tools/composer-bash-policy.test.ts",
	])("blocks repository file I/O for composer model: %s", command => {
		const result = checkComposerBashPolicy({ modelId: COMPOSER_MODEL, commands: [command] });
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.message).toBe(COMPOSER_BASH_POLICY_ERROR);
	});

	it.each([
		"bun test packages/coding-agent/test/tools/composer-bash-policy.test.ts",
		"bun run check:types",
		"cargo test -p pi-natives",
		"git status --short --branch",
		"git rev-parse HEAD",
		"npm --version",
		"pnpm --version",
		"yarn --version",
		"mise x bun@1.3.14 -- bun test packages/coding-agent/test/tools/composer-bash-policy.test.ts",
	])("allows terminal operations for composer model: %s", command => {
		expect(checkComposerBashPolicy({ modelId: COMPOSER_MODEL, commands: [command] })).toEqual({ allowed: true });
	});

	it("checks both raw and cwd-normalized commands", () => {
		const result = checkComposerBashPolicy({
			modelId: COMPOSER_MODEL,
			commands: ["cd repo && cat src/secret.ts", "cat src/secret.ts"],
		});
		expect(result.allowed).toBe(false);
	});

	it("preserves non-composer behavior", () => {
		expect(checkComposerBashPolicy({ modelId: NON_COMPOSER_MODEL, commands: ["cat src/secret.ts"] })).toEqual({
			allowed: true,
		});
		expect(checkComposerBashPolicy({ commands: ["cat src/secret.ts"] })).toEqual({ allowed: true });
	});
});
