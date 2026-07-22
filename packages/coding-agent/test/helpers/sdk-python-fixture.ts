#!/usr/bin/env bun
/**
 * Real-session fixture for the Python SDK tests.
 *
 * Control commands and fixture events share stdout: the first line is metadata,
 * and every later line is a JSON event. The fixture never writes diagnostics to
 * stdout. Commands arrive as newline-delimited JSON on stdin.
 */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { startProductionSdkHost } from "./sdk-production-host";

type Host = Awaited<ReturnType<typeof startProductionSdkHost>>;
type GateSpec = Parameters<Host["triggerGate"]>[0];
type Command =
	| { cmd: "trigger_ask"; question: string; options: string[] }
	| { cmd: "trigger_gate"; stage: string; kind: string; schema: Record<string, unknown> }
	| { cmd: "stop" };

function event(value: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseCommand(line: string): Command {
	const value = JSON.parse(line) as Record<string, unknown>;
	if (value.cmd === "stop") return { cmd: "stop" };
	if (value.cmd === "trigger_ask" && typeof value.question === "string" && Array.isArray(value.options)) {
		if (!value.options.every(option => typeof option === "string"))
			throw new Error("trigger_ask options must be strings");
		return { cmd: "trigger_ask", question: value.question, options: value.options as string[] };
	}
	if (
		value.cmd === "trigger_gate" &&
		typeof value.stage === "string" &&
		typeof value.kind === "string" &&
		value.schema !== null &&
		typeof value.schema === "object" &&
		!Array.isArray(value.schema)
	) {
		return {
			cmd: "trigger_gate",
			stage: value.stage,
			kind: value.kind,
			schema: value.schema as Record<string, unknown>,
		};
	}
	throw new Error("invalid fixture control command");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const selfCheck = args.includes("--self-check");
	const suppliedCwd = args.find(argument => argument !== "--self-check");
	const temporaryRepo =
		suppliedCwd === undefined ? await fs.mkdtemp(path.join(tmpdir(), "gjc-sdk-python-")) : undefined;
	const repo = suppliedCwd ?? temporaryRepo!;
	let host: Host | undefined;
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await host?.stop();
		if (temporaryRepo) await fs.rm(temporaryRepo, { recursive: true, force: true });
	};
	const terminate = () => {
		void stop().finally(() => process.exit(0));
	};
	process.once("SIGTERM", terminate);
	process.once("SIGINT", terminate);
	try {
		host = await startProductionSdkHost(repo);
		event({ sessionId: host.sessionId, url: host.endpoint.url, token: host.endpoint.token, repo });
		if (selfCheck) {
			await stop();
			return;
		}
		for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
			let command: Command;
			try {
				command = parseCommand(line);
			} catch (error) {
				event({ event: "error", kind: "control", reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
			if (command.cmd === "stop") break;
			const kind = command.cmd === "trigger_ask" ? "ask" : "workflow_gate";
			const registration =
				command.cmd === "trigger_ask"
					? host.triggerAsk(command.question, command.options)
					: host.triggerGate({ stage: command.stage, kind: command.kind, schema: command.schema } as GateSpec);
			if (!registration.registered) {
				event({ event: "error", kind, reason: registration.reason });
				continue;
			}
			event({ event: "registered", kind });
			void registration.result.then(
				value => event({ event: "resolved", kind, value }),
				error => event({ event: "error", kind, reason: error instanceof Error ? error.message : String(error) }),
			);
		}
		await stop();
	} catch (error) {
		await stop();
		throw error;
	}
}

void main().catch(error => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
