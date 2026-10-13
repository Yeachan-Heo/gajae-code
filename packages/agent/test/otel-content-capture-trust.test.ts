import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `agentLoop` reads `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` when
 * `captureMessageContent` is omitted. The project dotenv is merged into the
 * process environment, so the refusal is only visible from a process whose
 * cwd declares that key.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "otel-content-capture-trust-probe.ts");
const ENV_NAME = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";
const CANARY = "gjc-capture-canary";

setDefaultTimeout(60_000);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-otel-capture-trust-"));
	tempDirs.push(dir);
	return dir;
}

interface CaptureProbe {
	spanFound: boolean;
	envValue: string | null;
	inputMessages: string | null;
	outputMessages: string | null;
	systemInstructions: string | null;
	requestMessages: string | null;
	responseText: string | null;
	warnings: string[];
}

async function captureIn(
	cwd: string,
	dotenv: string | undefined,
	overrides: Record<string, string> = {},
	agentDotenv?: string,
): Promise<CaptureProbe> {
	if (dotenv !== undefined) fs.writeFileSync(path.join(cwd, ".env"), dotenv);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env[ENV_NAME];
	// Trusted file sources must not supply the switch from the developer machine.
	const agentDir = tempDir();
	if (agentDotenv !== undefined) fs.writeFileSync(path.join(agentDir, ".env"), agentDotenv);
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = agentDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const killer = setTimeout(() => {
		proc.kill();
	}, 20_000);
	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
		return JSON.parse(stdout.trim()) as CaptureProbe;
	} finally {
		clearTimeout(killer);
		if (proc.exitCode === null) proc.kill();
	}
}

describe("GenAI content capture project dotenv trust", () => {
	it("ignores a project .env that turns message content capture on", async () => {
		const cwd = tempDir();
		const captured = await captureIn(cwd, `${ENV_NAME}=full\n`);
		expect(captured.spanFound).toBe(true);
		expect(captured.envValue).toBe("full");
		expect(captured.inputMessages).toBeNull();
		expect(captured.requestMessages).toBeNull();
	});

	it("still captures full message content when the operator sets the env and the project does not", async () => {
		const cwd = tempDir();
		const captured = await captureIn(cwd, "OTHER=1\n", { [ENV_NAME]: "full" });
		expect(captured.spanFound).toBe(true);
		expect(captured.envValue).toBe("full");
		expect(captured.inputMessages).toContain(CANARY);
		expect(captured.warnings).toContain("full_content_capture_env_active");
	});

	it("keeps an operator summary when the project .env asks for full capture", async () => {
		const cwd = tempDir();
		const captured = await captureIn(cwd, `${ENV_NAME}=full\n`, { [ENV_NAME]: "summary" });
		expect(captured.spanFound).toBe(true);
		expect(captured.envValue).toBe("summary");
		expect(captured.inputMessages).toBeNull();
		expect(captured.requestMessages).toContain(CANARY);
	});

	it("honors an operator downgrade to false before the first capture read", async () => {
		const cwd = tempDir();
		const captured = await captureIn(cwd, "OTHER=1\n", {
			[ENV_NAME]: "full",
			OTEL_CAPTURE_TRUST_BEFORE_LOOP: "false",
		});
		expect(captured.spanFound).toBe(true);
		expect(captured.envValue).toBe("false");
		expect(captured.inputMessages).toBeNull();
		expect(captured.requestMessages).toBeNull();
		expect(captured.warnings).not.toContain("full_content_capture_env_active");
	});

	it("honors an operator downgrade to summary before the first capture read", async () => {
		const cwd = tempDir();
		const captured = await captureIn(cwd, "OTHER=1\n", {
			[ENV_NAME]: "full",
			OTEL_CAPTURE_TRUST_BEFORE_LOOP: "summary",
		});
		expect(captured.spanFound).toBe(true);
		expect(captured.envValue).toBe("summary");
		expect(captured.inputMessages).toBeNull();
		expect(captured.requestMessages).toContain(CANARY);
	});

	it("keeps capture off when the key is removed before the first read and a trusted agent env says full", async () => {
		const cwd = tempDir();
		const captured = await captureIn(
			cwd,
			"OTHER=1\n",
			{
				[ENV_NAME]: "full",
				OTEL_CAPTURE_TRUST_BEFORE_LOOP: "delete",
			},
			`${ENV_NAME}=full\n`,
		);
		expect(captured.spanFound).toBe(true);
		expect(captured.envValue).toBeNull();
		expect(captured.inputMessages).toBeNull();
		expect(captured.outputMessages).toBeNull();
		expect(captured.systemInstructions).toBeNull();
		expect(captured.requestMessages).toBeNull();
		expect(captured.responseText).toBeNull();
		expect(captured.warnings).not.toContain("full_content_capture_env_active");
	});
});
