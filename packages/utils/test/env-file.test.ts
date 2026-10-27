import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { canonicalEnvKey, parseEnvFileContent, projectEnvSnapshot } from "../src/env-file";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function randomString(random: () => number, alphabet: string, maxLength: number): string {
	const length = Math.floor(random() * (maxLength + 1));
	let value = "";
	for (let i = 0; i < length; i++) {
		value += alphabet[Math.floor(random() * alphabet.length)] ?? "";
	}
	return value;
}

describe("parseEnvFileContent dotenv comment properties", () => {
	test("matches Bun for seeded comment, quoted-hash, and escaped-quote values", async () => {
		const seed = 0x5eedc0de;
		const random = seededRandom(seed);
		const literalAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-";
		const commentAlphabet = `${literalAlphabet} \\"'`;
		const cases: Array<{ key: string; raw: string; expected: string }> = [];
		const addCase = (raw: string, expected: string): void => {
			cases.push({ key: `GJC_DOTENV_PROPERTY_${cases.length}`, raw, expected });
		};

		for (let i = 0; i < 64; i++) {
			const prefix = randomString(random, literalAlphabet, 16);
			const backslashes = "\\".repeat(i < 13 ? i : Math.floor(random() * 13));
			const suffix = randomString(random, commentAlphabet, 20);
			addCase(`${prefix}${backslashes}#${suffix}`, `${prefix}${backslashes}`);
		}

		for (let i = 0; i < 24; i++) {
			const quote = i % 2 === 0 ? '"' : "'";
			const prefix = randomString(random, literalAlphabet, 16);
			const suffix = randomString(random, literalAlphabet, 20);
			const value = `${prefix}#${suffix}`;
			addCase(`${quote}${value}${quote}`, value);
		}

		for (let i = 0; i < 24; i++) {
			const prefix = randomString(random, literalAlphabet, 16);
			const escaped = randomString(random, literalAlphabet, 12);
			const suffix = randomString(random, commentAlphabet, 16);
			const slashCount = 1 + 2 * (i % 4);
			const backslashes = "\\".repeat(slashCount);
			const escapedOutside = `${prefix}${backslashes}"${escaped}#${suffix}`;
			addCase(escapedOutside, `${prefix}${backslashes}"${escaped}`);

			const quotedSuffix = randomString(random, literalAlphabet, 16);
			const quotedEscaped = `"${prefix}${backslashes}"${escaped}#${quotedSuffix}"`;
			addCase(quotedEscaped, `${prefix}${backslashes}"${escaped}#${quotedSuffix}`);
		}

		const dotenv = `${cases.map(({ key, raw }) => `${key}=${raw}`).join("\n")}\n`;
		const cwd = tempDir("gjc-env-comment-property-");
		const home = tempDir("gjc-env-comment-property-home-");
		fs.writeFileSync(path.join(cwd, ".env"), dotenv);
		const keys = cases.map(({ key }) => key);
		const probe = path.join(cwd, "dotenv-probe.ts");
		await Bun.write(
			probe,
			`const keys = ${JSON.stringify(keys)};\n` +
				`console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))));\n`,
		);

		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home };
		for (const key of keys) delete childEnv[key];
		const proc = Bun.spawn([process.execPath, probe], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);

		const bunValues = JSON.parse(stdout.trim()) as Record<string, string | null>;
		const expected = Object.fromEntries(cases.map(({ key, expected }) => [key, expected]));
		expect(parseEnvFileContent(dotenv), `seed ${seed}`).toEqual(expected);
		expect(bunValues, `seed ${seed}`).toEqual(expected);
	}, 15_000);
});

describe("projectEnvSnapshot non-identifier declaration properties", () => {
	test("marks seeded Bun-loaded npm key variants dynamic across dotenv layers", async () => {
		const seed = 0x5eedc0de;
		const random = seededRandom(seed);
		const separators = ["_", "-", "."];
		const layerFiles = [".env", ".env.development", ".env.local", ".env.development.local"];
		const declarationsByLayer: Record<string, string[]> = Object.fromEntries(layerFiles.map(file => [file, []]));
		const cases: Array<{ key: string; value: string }> = [];

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const words =
				caseIndex % 2 === 0 ? ["npm", "config", "node", "options"] : ["npm", "config", "script", "shell"];
			const casedWords = words.map(word =>
				[...word].map(letter => (random() < 0.5 ? letter.toUpperCase() : letter)).join(""),
			);
			const prefixSeparator = separators[caseIndex % separators.length] ?? "_";
			const optionSeparator = caseIndex % 2 === 0 ? "-" : ".";
			const key = `${casedWords[0]}${prefixSeparator}${casedWords[1]}_${casedWords[2]}${optionSeparator}${casedWords[3]}`;
			const value = `GJC_DOTENV_NON_IDENTIFIER_${caseIndex}`;
			const declaration =
				caseIndex % 3 === 0
					? `${key}=${value}`
					: caseIndex % 3 === 1
						? `export ${key} = ${value}`
						: `${key} : ${value}`;
			const layer = layerFiles[caseIndex % layerFiles.length] ?? ".env";
			declarationsByLayer[layer]?.push(declaration);
			cases.push({ key, value });
		}

		expect(new Set(cases.map(({ key }) => key)).size).toBe(cases.length);

		const cwd = tempDir("gjc-env-nonidentifier-property-");
		const home = tempDir("gjc-env-nonidentifier-property-home-");
		for (const [file, declarations] of Object.entries(declarationsByLayer)) {
			fs.writeFileSync(path.join(cwd, file), `${declarations.join("\n")}\n`);
		}

		const keys = cases.map(({ key }) => key);
		const envFileSource = path.resolve(import.meta.dir, "../src/env-file.ts");
		const probe = path.join(cwd, "dotenv-nonidentifier-probe.ts");
		await Bun.write(
			probe,
			`import { canonicalEnvKey, projectEnvSnapshot } from ${JSON.stringify(envFileSource)};\n` +
				`const keys = ${JSON.stringify(keys)};\n` +
				`const snapshot = projectEnvSnapshot(process.cwd());\n` +
				`console.log(JSON.stringify({\n` +
				`  loaded: keys.map(key => process.env[key] ?? null),\n` +
				`  snapshotHas: keys.map(key => Object.hasOwn(snapshot.values, canonicalEnvKey(key))),\n` +
				`  dynamic: keys.map(key => snapshot.dynamic.has(canonicalEnvKey(key))),\n` +
				`}));\n`,
		);

		const generatedKeys = new Set(keys.map(canonicalEnvKey));
		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, NODE_ENV: "development" };
		for (const inheritedKey of Object.keys(childEnv)) {
			if (generatedKeys.has(canonicalEnvKey(inheritedKey))) delete childEnv[inheritedKey];
		}
		const proc = Bun.spawn([process.execPath, probe], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);

		const result = JSON.parse(stdout.trim()) as {
			loaded: Array<string | null>;
			snapshotHas: boolean[];
			dynamic: boolean[];
		};
		for (const [caseIndex, { key, value }] of cases.entries()) {
			const context = `seed ${seed}, case ${caseIndex}, key ${key}`;
			expect(result.loaded[caseIndex], context).toBe(value);
			expect(result.snapshotHas[caseIndex], context).toBe(true);
			expect(result.dynamic[caseIndex], context).toBe(true);
		}
	}, 15_000);
});

describe("projectEnvSnapshot quoted declarations", () => {
	test("compares a plain quoted literal and refuses a quoted escape", () => {
		const cwd = tempDir("gjc-env-quote-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'PLAIN="hello"\nESCAPED="a\\nb"\nBARE=/tmp/plain\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.values.PLAIN).toBe("hello");
		expect(snapshot.dynamic.has("PLAIN")).toBe(false);
		expect(snapshot.dynamic.has("ESCAPED")).toBe(true);
		expect(snapshot.dynamic.has("BARE")).toBe(false);
		expect(snapshot.values.BARE).toBe("/tmp/plain");
	});

	test("refuses a quote that continues onto the next physical line", () => {
		const cwd = tempDir("gjc-env-quote-ml-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.dynamic.has("GJC_CODING_AGENT_DIR")).toBe(true);
	});

	test("does not mark an escaped dollar dynamic", () => {
		const cwd = tempDir("gjc-env-escaped-dollar-");
		fs.writeFileSync(path.join(cwd, ".env"), "LITERAL=\\$UNSET\nREAL=$UNSET\nTICK=`UNSET`\n");
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.values.LITERAL).toBe("$UNSET");
		expect(snapshot.dynamic.has("LITERAL")).toBe(false);
		expect(snapshot.dynamic.has("REAL")).toBe(true);
		expect(snapshot.dynamic.has("TICK")).toBe(true);
	});
});

describe("project declaration expansion", () => {
	test("treats an escaped dollar as a literal and a real expansion as dynamic", async () => {
		const name = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/);
		fc.assert(
			fc.property(name, ident => {
				const cwd = tempDir("gjc-env-dyn-prop-");
				fs.writeFileSync(
					path.join(cwd, ".env"),
					`LITERAL=\\$${ident}\nREAL=$${ident}\nTICK=\`${ident}\`\nMIX=pre\\$${ident}$${ident}\n`,
				);
				const snapshot = projectEnvSnapshot(cwd);
				expect(snapshot.values.LITERAL).toBe(`$${ident}`);
				expect(snapshot.dynamic.has("LITERAL")).toBe(false);
				expect(snapshot.dynamic.has("REAL")).toBe(true);
				expect(snapshot.dynamic.has("TICK")).toBe(true);
				expect(snapshot.dynamic.has("MIX")).toBe(true);
			}),
			{ seed: 7219, numRuns: 64 },
		);

		const cwd = tempDir("gjc-env-dyn-bun-");
		const home = tempDir("gjc-env-dyn-bun-home-");
		fs.writeFileSync(path.join(cwd, ".env"), "LITERAL=\\$UNSET\n");
		const snapshot = projectEnvSnapshot(cwd);
		const script = path.join(cwd, "loaded-literal.ts");
		await Bun.write(script, "console.log(JSON.stringify({ loaded: process.env.LITERAL ?? null }));\n");
		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		delete childEnv.LITERAL;
		const proc = Bun.spawn([process.execPath, script], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, stderr).toBe(0);
		const loaded = (JSON.parse(stdout.trim()) as { loaded: string | null }).loaded;
		expect(loaded).toBe(snapshot.values.LITERAL);
		expect(loaded).toBe("$UNSET");
	});
});

describe("projectEnvSnapshot bounded reads", () => {
	test("marks an oversized dotenv layer incomplete without parsing partial declarations", () => {
		const cwd = tempDir("gjc-env-bounded-large-");
		fs.writeFileSync(path.join(cwd, ".env"), `TMPDIR=/tmp/planted\n${"x".repeat(128)}`);

		const snapshot = projectEnvSnapshot(cwd, { maxFileBytes: 16 });
		expect(snapshot.incomplete).toBe(true);
		expect(snapshot.values.TMPDIR).toBeUndefined();
	});

	test("rejects a device-file dotenv layer without blocking", async () => {
		if (process.platform === "win32") return;
		const cwd = tempDir("gjc-env-bounded-device-");
		const processCwd = tempDir("gjc-env-bounded-runner-");
		fs.symlinkSync("/dev/zero", path.join(cwd, ".env"));
		const source = path.resolve(import.meta.dir, "../src/env-file.ts");
		const script = path.join(processCwd, "snapshot-probe.ts");
		await Bun.write(
			script,
			`import { projectEnvSnapshot } from ${JSON.stringify(source)};\n` +
				`console.log(JSON.stringify({ incomplete: projectEnvSnapshot(${JSON.stringify(cwd)}, { maxFileBytes: 64 }).incomplete }));\n`,
		);
		const proc = Bun.spawn([process.execPath, script], {
			cwd: processCwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5_000,
			killSignal: "SIGKILL",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({ incomplete: true });
	}, 10_000);
});

const dirsSource = path.join(import.meta.dir, "../src/dirs.ts");

async function printedAgentDir(cwd: string, env: Record<string, string | undefined> = {}): Promise<string> {
	const script = path.join(cwd, "print-agent-dir.ts");
	await Bun.write(script, `import { getAgentDir } from ${JSON.stringify(dirsSource)};\nconsole.log(getAgentDir());\n`);
	const childEnv: Record<string, string | undefined> = { ...process.env, HOME: env.HOME, ...env };
	delete childEnv.GJC_CODING_AGENT_DIR;
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.GJC_CONFIG_DIR;
	delete childEnv.PI_CONFIG_DIR;
	if (env.GJC_CODING_AGENT_DIR !== undefined) childEnv.GJC_CODING_AGENT_DIR = env.GJC_CODING_AGENT_DIR;
	const proc = Bun.spawn([process.execPath, script], {
		cwd,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(stderr || stdout || `getAgentDir probe exited ${code}`);
	const printed = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (printed.length === 0) throw new Error(`getAgentDir probe printed nothing: ${stderr}`);
	return printed;
}

describe("getAgentDir quote provenance", () => {
	test("does not adopt an escaped-dollar project agent directory", async () => {
		const cwd = tempDir("gjc-env-esc-agent-");
		const home = tempDir("gjc-env-esc-home-");
		const plantedRoot = tempDir("gjc-env-esc-plant-");
		const planted = path.join(plantedRoot, "$UNSET");
		fs.mkdirSync(planted);
		fs.writeFileSync(path.join(planted, ".env"), "OPENAI_API_KEY=planted-project-secret\n");
		fs.writeFileSync(path.join(cwd, ".env"), `GJC_CODING_AGENT_DIR=${plantedRoot}/\\$UNSET\n`);
		const agentDir = await printedAgentDir(cwd, { HOME: home, USERPROFILE: home });
		expect(agentDir.includes("$UNSET")).toBe(false);
		expect(agentDir.includes(plantedRoot)).toBe(false);
	});

	test("does not trust a credential file in an escaped-dollar project agent directory", async () => {
		const cwd = tempDir("gjc-env-esc-cred-");
		const home = tempDir("gjc-env-esc-cred-home-");
		const plantedRoot = tempDir("gjc-env-esc-cred-plant-");
		const planted = path.join(plantedRoot, "$UNSET");
		fs.mkdirSync(planted);
		fs.writeFileSync(path.join(planted, ".env"), "OPENAI_API_KEY=planted-project-secret\n");
		fs.writeFileSync(path.join(cwd, ".env"), `GJC_CODING_AGENT_DIR=${plantedRoot}/\\$UNSET\n`);
		const envSource = path.join(import.meta.dir, "../src/env.ts");
		const script = path.join(cwd, "print-agent-cred.ts");
		await Bun.write(
			script,
			`import { getAgentDir } from ${JSON.stringify(dirsSource)};\n` +
				`import { $credentialEnv } from ${JSON.stringify(envSource)};\n` +
				`console.log(JSON.stringify({ agentDir: getAgentDir(), key: $credentialEnv("OPENAI_API_KEY") ?? null }));\n`,
		);
		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
		delete childEnv.GJC_CODING_AGENT_DIR;
		delete childEnv.PI_CODING_AGENT_DIR;
		delete childEnv.GJC_CONFIG_DIR;
		delete childEnv.PI_CONFIG_DIR;
		delete childEnv.OPENAI_API_KEY;
		const proc = Bun.spawn([process.execPath, script], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, stderr).toBe(0);
		const parsed = JSON.parse(stdout.trim()) as { agentDir: string; key: string | null };
		expect(parsed.agentDir.includes("$UNSET")).toBe(false);
		expect(parsed.key).toBeNull();
	});

	test("does not follow a double-quoted newline planted by the project .env", async () => {
		const cwd = tempDir("gjc-env-quote-nl-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-agent\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a planted value whose backslash is not an escape", async () => {
		const cwd = tempDir("gjc-env-quote-bs-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted\\agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted")).toBe(false);
	});

	test("does not follow a double-quoted agent dir split across physical lines", async () => {
		const cwd = tempDir("gjc-env-quote-ml-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-multiline")).toBe(false);
	});

	test("does not follow a legacy PI_CODING_AGENT_DIR quoted newline", async () => {
		const cwd = tempDir("gjc-env-quote-pi-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'PI_CODING_AGENT_DIR="/tmp/planted-pi\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-pi")).toBe(false);
	});

	test("does not follow a quoted CRLF that path.resolve would collapse", async () => {
		const cwd = tempDir("gjc-env-quote-crlf-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/segment\r\n/../planted-agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a backslash and physical CR planted inside double quotes", async () => {
		const cwd = tempDir("gjc-env-quote-cr-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-cr\\\r"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-cr")).toBe(false);
	});

	test("still honors an operator agent dir when the project has no .env", async () => {
		const cwd = tempDir("gjc-env-quote-op-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors a different unquoted operator agent dir", async () => {
		const cwd = tempDir("gjc-env-quote-op-unquoted-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), "GJC_CODING_AGENT_DIR=/tmp/planted-unquoted\n");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors an operator dir when a plain quote has a trailing comment", async () => {
		const cwd = tempDir("gjc-env-quote-op-comment-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/plain" # ordinary comment\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors an operator dir when an unquoted comment contains a quote", async () => {
		const cwd = tempDir("gjc-env-quote-op-unquoted-comment-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), "GJC_CODING_AGENT_DIR=/tmp/plain # operator's note\n");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors a different operator dir when the project quote is plain", async () => {
		const cwd = tempDir("gjc-env-quote-op-plain-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-plain"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});
});
