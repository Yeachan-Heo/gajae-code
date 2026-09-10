import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	classifyPublicCommandFailure,
	EVIDENCE_UNAVAILABLE_WARNING,
	normalizePublicCommandFailure,
	PublicCommandFailure,
	type PublicCommandFailureInput,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";
import { type EvidenceReference, readCommandEvidence } from "../src/cli/public-command-evidence";

const command = ["sdk", "session", "send"];
const failure = (input: PublicCommandFailureInput) => new PublicCommandFailure(input);
const posix = process.platform === "win32" ? test.skip : test;
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "gjc-public-errors-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("parser and invalid JSON failures are not applied, nonretryable, local-help exit two without echo", async () => {
	for (const kind of ["usage", "invalid_json"] as const) {
		const result = await renderPublicCommandFailure(failure({ kind }), { command, json: true });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe("");
		expect(result.stdout.endsWith("\n")).toBe(true);
		expect(result.envelope.error).toMatchObject({
			code: kind,
			outcomeCertainty: "not-applied",
			retryability: "no",
			category: "usage",
		});
		expect(result.envelope.error.nextSteps[0]!.argv).toEqual([...command, "--help"]);
		expect(JSON.parse(result.stdout)).toEqual(result.envelope);
	}
});

test("typed transport, acceptance, authorization and unknown proofs map semantically", () => {
	const cases = [
		[{ kind: "unavailable", proof: "pre-send" }, "not-applied", "unknown"],
		[{ kind: "broker_unavailable" }, "unknown", "unknown"],
		[{ kind: "endpoint_stale", proof: "sent" }, "unknown", "unknown"],
		[{ kind: "timeout", proof: "pre-send" }, "not-applied", "unknown"],
		[{ kind: "timeout" }, "unknown", "unknown"],
		[{ kind: "wait_timeout" }, "applied", "no"],
		[{ kind: "uncertain_after_send", proof: "pre-send" }, "unknown", "unknown"],
		[{ kind: "authorization_denied" }, "unknown", "no"],
		[{ kind: "authorization_denied", proof: "pre-effect" }, "not-applied", "no"],
		[{ kind: "authorization_denied", proof: "completed" }, "applied", "no"],
	] as const;
	for (const [input, outcomeCertainty, retryability] of cases) {
		expect(classifyPublicCommandFailure(failure(input), command)).toMatchObject({
			outcomeCertainty,
			retryability,
			exitCode: 1,
		});
	}
});

test("unknown thrown strings and shaped objects cannot supply diagnoses or secrets", async () => {
	for (const error of [
		new Error("secret-token https://credential@host/path"),
		"secret-token",
		{
			kind: "usage",
			message: "secret-token",
			proof: "pre-send",
			references: [{ kind: "sessionId", value: "secret-token" }],
		},
	]) {
		expect(normalizePublicCommandFailure(error).input.kind).toBe("operation_failed");
		const rendered = await renderPublicCommandFailure(error, { command, json: true });
		expect(rendered.stdout).not.toContain("secret-token");
		expect(rendered.envelope.error).toMatchObject({
			code: "operation_failed",
			outcomeCertainty: "unknown",
			retryability: "unknown",
			references: [],
		});
	}
});

test("broker restart and authorization guidance neither restarts SDK nor exposes credentials", async () => {
	const restarting = classifyPublicCommandFailure(
		failure({ kind: "broker_restarting", proof: "pre-send", restartJustified: true, daemonKind: "telegram" }),
		command,
	);
	const encoded = JSON.stringify(restarting);
	expect(restarting).toMatchObject({ retryability: "unknown", outcomeCertainty: "not-applied" });
	expect(restarting.nextSteps.some(step => step.description.includes("do not restart again"))).toBe(true);
	expect(encoded).not.toContain('["daemon","restart"');
	expect(encoded).not.toContain('["sdk","restart"');
	const denied = await renderPublicCommandFailure(
		failure({ kind: "authorization_denied", ...{ message: "secret-token" } }),
		{ command },
	);
	expect(denied.stdout).toBe("");
	expect(denied.stderr).toContain("authorized caller");
	expect(denied.stderr).not.toContain("secret-token");
});

test("same-kind daemon restart requires diagnosed evidence and disruption confirmation", () => {
	for (const restartJustified of [false, true]) {
		const result = classifyPublicCommandFailure(
			failure({ kind: "daemon_stale", daemonKind: "slack", restartJustified, proof: "pre-effect" }),
			["daemon", "restart"],
		);
		expect(
			result.nextSteps.some(step => JSON.stringify(step.argv) === JSON.stringify(["daemon", "status", "slack"])),
		).toBe(true);
		const restart = result.nextSteps.find(step => step.argv?.[1] === "restart");
		if (restartJustified)
			expect(restart).toMatchObject({
				disruption: "interrupts-work",
				requiresConfirmation: true,
				argv: ["daemon", "restart", "slack"],
			});
		else expect(restart).toBeUndefined();
	}
	const mixed = classifyPublicCommandFailure(
		failure({
			kind: "daemon_mixed",
			targets: [
				{ kind: "telegram", outcome: "applied" },
				{ kind: "discord", outcome: "unknown" },
			],
		}),
		["daemon", "restart"],
	);
	expect(mixed.outcomeCertainty).toBe("unknown");
	expect(mixed.nextSteps.some(step => step.description.includes("telegram: outcome applied"))).toBe(true);
	expect(mixed.nextSteps.every(step => step.argv?.[1] !== "restart")).toBe(true);
});

test("safe reference allowlist preserves complete values and only complete concrete status argv", async () => {
	const references = [
		{ kind: "sessionId", value: "session-1" },
		{ kind: "operationRef", value: "op-1" },
		{ kind: "idempotencyKey", value: "  key\n漢字😀  " },
		{ kind: "password", value: "secret-token" },
	] as EvidenceReference[];
	const result = await renderPublicCommandFailure(failure({ kind: "uncertain_after_send", references }), {
		command,
		json: true,
	});
	expect(result.envelope.error.references).toEqual(references.slice(0, 3));
	expect(result.stdout).not.toContain("secret-token");
	expect(
		result.envelope.error.nextSteps.some(
			step => JSON.stringify(step.argv) === JSON.stringify(["sdk", "session", "status", "session-1", "op-1"]),
		),
	).toBe(true);
	const unsafe = classifyPublicCommandFailure(
		failure({
			kind: "uncertain_after_send",
			references: [
				{ kind: "sessionId", value: "--help" },
				{ kind: "operationRef", value: "op\n1" },
			],
		}),
		command,
	);
	expect(unsafe.nextSteps.every(step => step.argv?.[2] !== "status")).toBe(true);
});

posix("ordinary complete errors never initialize a store", async () => {
	await fixture(async root => {
		const result = await renderPublicCommandFailure(failure({ kind: "timeout" }), {
			command,
			json: true,
			agentDir: root,
		});
		expect(result.envelope).toMatchObject({ complete: true, evidence: { status: "inline" }, continuation: null });
		expect(await fs.readdir(root)).toEqual([]);
	});
});

posix("overflow retains exact sanitized evidence and leaves original accepted-operation truth intact", async () => {
	await fixture(async root => {
		const value = '漢字😀\n"\\'.repeat(2000);
		const result = await renderPublicCommandFailure(
			failure({ kind: "wait_timeout", references: [{ kind: "operationRef", value }] }),
			{ command, json: true, agentDir: root, scopeAgentDir: root },
		);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8192);
		expect(result.exitCode).toBe(1);
		expect(result.envelope.error).toMatchObject({
			code: "wait_timeout",
			outcomeCertainty: "applied",
			retryability: "no",
		});
		expect(result.envelope.complete).toBe(false);
		const evidence = result.envelope.evidence;
		if (evidence.status !== "retained") throw new Error(JSON.stringify(evidence));
		expect(result.envelope.continuation).toMatchObject({ id: evidence.id, sha256: evidence.sha256, page: 1 });
		const chunks: Buffer[] = [];
		for (let page = 1; ; page++) {
			const read = await readCommandEvidence({
				agentDir: root,
				family: "sdk",
				id: evidence.id,
				sha256: evidence.sha256,
				page,
			});
			if (read.status !== "available") throw new Error(read.reason);
			chunks.push(Buffer.from(read.page.fragments[0]!.data, "base64"));
			if (read.page.complete) break;
		}
		expect(JSON.parse(Buffer.concat(chunks).toString()).references).toEqual([{ kind: "operationRef", value }]);
	});
});

posix("failed publication preserves classification, whole fitting refs and explicit unavailable warning", async () => {
	await fixture(async root => {
		const store = path.join(root, "cli-error-evidence-v1");
		await fs.mkdir(store, { mode: 0o700 });
		await fs.writeFile(path.join(store, "lock"), "", { mode: 0o600 });
		for (const json of [false, true]) {
			const result = await renderPublicCommandFailure(
				failure({
					kind: "uncertain_after_send",
					references: [
						{ kind: "sessionId", value: "complete-small-session" },
						{ kind: "operationRef", value: "x".repeat(30_000) },
					],
				}),
				{ command, json, agentDir: root },
			);
			expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(8192);
			expect(result.envelope).toMatchObject({
				complete: false,
				continuation: null,
				evidence: {
					status: "unavailable",
					reason: "store_busy",
					warning: EVIDENCE_UNAVAILABLE_WARNING,
					missingKinds: ["operationRef"],
				},
			});
			expect(result.envelope.error).toMatchObject({
				code: "uncertain_after_send",
				outcomeCertainty: "unknown",
				retryability: "unknown",
				references: [{ kind: "sessionId", value: "complete-small-session" }],
			});
			expect(result.envelope.omittedOptional.every(item => !item.path.includes("references"))).toBe(true);
		}
	});
});

test("oversized evidence without storage remains bounded and unavailable, including Unicode and controls", async () => {
	for (const value of [
		"x".repeat(8191),
		"x".repeat(8192),
		"x".repeat(8193),
		"漢字😀".repeat(8192),
		"\u001b[31m\n\ud800".repeat(3000),
	]) {
		for (const json of [false, true]) {
			const result = await renderPublicCommandFailure(
				failure({ kind: "wait_timeout", references: [{ kind: "operationRef", value }] }),
				{ command, json },
			);
			const output = result.stdout + result.stderr;
			expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
			expect(output).not.toContain("\u001b");
			expect(result.envelope).toMatchObject({
				complete: false,
				continuation: null,
				evidence: { status: "unavailable", warning: EVIDENCE_UNAVAILABLE_WARNING },
			});
			expect(result.envelope.error).toMatchObject({ outcomeCertainty: "applied", retryability: "no" });
		}
	}
});

for (const json of [false, true]) {
	test(`serialized ${json ? "JSON" : "text"} boundary admits 8191/8192 bytes and rejects the 8193-byte candidate whole`, async () => {
		const renderLength = (length: number, agentDir?: string) =>
			renderPublicCommandFailure(
				failure({
					kind: "authorization_denied",
					references: [{ kind: "operationRef", value: "x".repeat(length) }],
				}),
				{ command, json, agentDir },
			);
		// Calibrate against the actual final renderer, including newline, escaping and optional-step omission.
		let low = 1;
		let high = 8192;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const rendered = await renderLength(middle);
			if (rendered.envelope.complete) low = middle;
			else high = middle - 1;
		}
		for (const [length, bytes] of [
			[low - 1, 8191],
			[low, 8192],
		] as const) {
			const rendered = await renderLength(length);
			expect(Buffer.byteLength(rendered.stdout + rendered.stderr)).toBe(bytes);
			expect(rendered.envelope).toMatchObject({
				complete: true,
				evidence: { status: "inline" },
				continuation: null,
			});
			expect(rendered.envelope.error.references).toEqual([{ kind: "operationRef", value: "x".repeat(length) }]);
			expect(rendered.envelope.error.nextSteps).toEqual([]);
		}
		const boundary = await renderLength(low);
		// One ASCII byte added to the same final envelope would be exactly 8193 bytes.
		expect(Buffer.byteLength(boundary.stdout + boundary.stderr) + 1).toBe(8193);
		const unavailable = await renderLength(low + 1);
		expect(unavailable.envelope).toMatchObject({
			complete: false,
			continuation: null,
			evidence: { status: "unavailable" },
		});
		expect(unavailable.envelope.error.references).toEqual([]);
		expect(Buffer.byteLength(unavailable.stdout + unavailable.stderr)).toBeLessThanOrEqual(8192);
		expect(unavailable.envelope.error.nextSteps.every(step => step.argv?.[2] !== "status")).toBe(true);
		if (process.platform !== "win32")
			await fixture(async root => {
				const retained = await renderLength(low + 1, root);
				expect(retained.envelope).toMatchObject({ complete: false, evidence: { status: "retained" } });
				expect(retained.envelope.error.references).toEqual([]);
				expect(Buffer.byteLength(retained.stdout + retained.stderr)).toBeLessThanOrEqual(8192);
				const evidence = retained.envelope.evidence;
				if (evidence.status !== "retained") throw new Error("Expected retained evidence");
				const chunks: Buffer[] = [];
				for (let page = 1; ; page++) {
					const read = await readCommandEvidence({
						agentDir: root,
						family: "sdk",
						id: evidence.id,
						sha256: evidence.sha256,
						page,
					});
					if (read.status !== "available") throw new Error(read.reason);
					chunks.push(Buffer.from(read.page.fragments[0]!.data, "base64"));
					if (read.page.complete) break;
				}
				expect(JSON.parse(Buffer.concat(chunks).toString()).references).toEqual([
					{ kind: "operationRef", value: "x".repeat(low + 1) },
				]);
			});
		const diagnostic = await renderPublicCommandFailure(
			failure({
				kind: "authorization_denied",
				references: [{ kind: "operationRef", value: "x".repeat(low - 100) }],
				diagnostics: ["router_cleanup_failed", "broker_cleanup_failed"],
			}),
			{ command, json },
		);
		expect(Buffer.byteLength(diagnostic.stdout + diagnostic.stderr)).toBeLessThanOrEqual(8192);
		if (diagnostic.envelope.diagnostics) {
			expect(diagnostic.envelope.diagnostics.map(item => item.code)).toEqual([
				"router_cleanup_failed",
				"broker_cleanup_failed",
			]);
		} else {
			expect(diagnostic.envelope.omittedOptional).toContainEqual({ path: "diagnostics", reason: "output_budget" });
		}
	});
}

test("typed cleanup diagnostics merge with boundary diagnostics once without changing the primary outcome", async () => {
	const rendered = await renderPublicCommandFailure(
		failure({
			kind: "wait_timeout",
			diagnostics: ["router_cleanup_failed", "broker_cleanup_failed", "router_cleanup_failed"],
		}),
		{
			command,
			json: true,
			diagnostics: ["macos_nofile_limit_low", "broker_cleanup_failed"],
		},
	);
	expect(rendered.envelope.diagnostics?.map(diagnostic => diagnostic.code)).toEqual([
		"macos_nofile_limit_low",
		"router_cleanup_failed",
		"broker_cleanup_failed",
	]);
	expect(rendered.envelope.error).toMatchObject({
		code: "wait_timeout",
		outcomeCertainty: "applied",
		retryability: "no",
	});
	expect(rendered.exitCode).toBe(1);
	expect(rendered.stderr).toBe("");
	expect(JSON.parse(rendered.stdout)).toEqual(rendered.envelope);
});
