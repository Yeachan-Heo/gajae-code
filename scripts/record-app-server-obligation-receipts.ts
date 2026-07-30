#!/usr/bin/env bun
// Record app-server obligation receipts by ACTUALLY running each gate.
//
// The obligations verifier re-executes every gate live and compares the result against its
// receipt, so a receipt is only ever a record of a real run: this generator never fabricates one.
// A gate whose command fails, or whose output lacks the manifest's marker, is left WITHOUT a
// receipt so the verifier keeps reporting it as BLOCKED.
//
// Usage:
//   bun scripts/record-app-server-obligation-receipts.ts [--gate <id>]...

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { currentTreeHash, normalizeCapturedOutput } from "../packages/coding-agent/src/app-server/obligations-verifier";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repositoryRoot, "packages/coding-agent");
const appServerRoot = path.join(packageRoot, "src/app-server");

type Gate = {
	readonly id: string;
	readonly receiptContract: {
		readonly argv: readonly string[];
		readonly outputArtifactPath: string;
		readonly outputMarker: string;
	};
};

const sha256 = (value: Uint8Array | string): string =>
	createHash("sha256")
		.update(typeof value === "string" ? new TextEncoder().encode(value) : value)
		.digest("hex");

function requestedGates(argv: readonly string[]): Set<string> | undefined {
	const ids = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== "--gate") throw new Error("Usage: record-app-server-obligation-receipts.ts [--gate <id>]...");
		const id = argv[index + 1];
		if (!id || id.startsWith("--")) throw new Error("--gate requires a gate id");
		ids.add(id);
		index += 1;
	}
	return ids.size > 0 ? ids : undefined;
}

/** Resolve the manifest argv the same way the verifier does: bun plus repo-relative scripts. */
function resolveArgv(argv: readonly string[]): string[] {
	if (argv[0] !== "bun") return [...argv];
	return [
		process.execPath,
		...argv.slice(1).map(argument => (argument.endsWith(".ts") ? path.resolve(packageRoot, argument) : argument)),
	];
}

async function main(): Promise<void> {
	const selected = requestedGates(process.argv.slice(2));
	const manifest = (await Bun.file(path.join(appServerRoot, "obligations.manifest.json")).json()) as {
		receiptDirectory: string;
		gates: Gate[];
	};
	const receiptDirectory = path.join(packageRoot, manifest.receiptDirectory);
	await fs.mkdir(receiptDirectory, { recursive: true });

	// Two passes: every artifact is written FIRST, then one tree snapshot is taken and shared by
	// all receipts. Writing an artifact changes the snapshot, so a per-gate snapshot would stale
	// every receipt recorded before it.
	const pending: Array<{ gate: Gate; exitCode: number; output: string }> = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	for (const gate of manifest.gates) {
		if (selected && !selected.has(gate.id)) continue;
		const outputPath = path.join(packageRoot, gate.receiptContract.outputArtifactPath);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		let exitCode: number;
		let output: string;
		try {
			const child = Bun.spawn(resolveArgv(gate.receiptContract.argv), {
				cwd: packageRoot,
				env: { CI: "1", HOME: path.join(packageRoot, ".obligations-home"), NO_COLOR: "1", PATH: "/usr/bin:/bin" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			exitCode = code;
			output = normalizeCapturedOutput(`${stdout}${stderr}`);
		} catch (error) {
			skipped.push({
				id: gate.id,
				reason: `command is not executable: ${error instanceof Error ? error.message : error}`,
			});
			continue;
		}
		if (exitCode !== 0) {
			skipped.push({ id: gate.id, reason: `command exited ${exitCode}; the gate stays BLOCKED` });
			continue;
		}
		if (!output.includes(gate.receiptContract.outputMarker)) {
			skipped.push({ id: gate.id, reason: `output is missing the marker ${gate.receiptContract.outputMarker}` });
			continue;
		}
		await Bun.write(outputPath, output);
		pending.push({ gate, exitCode, output });
	}

	const treeHash = await currentTreeHash(packageRoot, manifest.receiptDirectory);
	const recorded: string[] = [];
	for (const { gate, exitCode, output } of pending) {
		const receipt = {
			receiptVersion: 1,
			gateId: gate.id,
			argv: gate.receiptContract.argv,
			cwd: ".",
			exitCode,
			treeHash,
			artifacts: [{ path: gate.receiptContract.outputArtifactPath, sha256: sha256(output) }],
		};
		await Bun.write(
			path.join(receiptDirectory, `${gate.id}.receipt.json`),
			`${JSON.stringify(receipt, null, "\t")}\n`,
		);
		recorded.push(gate.id);
	}

	for (const gate of recorded) process.stdout.write(`RECORDED ${gate}\n`);
	for (const { id, reason } of skipped) process.stdout.write(`NOT RECORDED ${id}: ${reason}\n`);
	if (recorded.length === 0) process.exitCode = 1;
}

await main();
