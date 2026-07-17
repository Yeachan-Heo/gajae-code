#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import path from "node:path";
import { NotificationServer } from "../../natives/native/index.js";
import { Broker } from "../src/sdk/broker/broker";
import { brokerDiscoveryPath } from "../src/sdk/broker/discovery";
import { brokerIdentityPath, getBrokerIdentityKey } from "../src/sdk/broker/identity";

type Check = { id: string; description: string; kind: "assertion" | "negative-test"; command?: string };
type Manifest = { version: 1; checks: Check[] };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function rejectedWebSocket(url: string): Promise<void> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("unauthorized WebSocket was not rejected")), 2_000);
		ws.addEventListener(
			"close",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(timeout);
				ws.close();
				reject(new Error("unauthorized WebSocket connected"));
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

async function mode(file: string): Promise<number> {
	return (await fs.stat(file)).mode & 0o777;
}

async function main(): Promise<void> {
	const manifestPath = process.argv[2];
	if (!manifestPath) throw new Error("Usage: bun scripts/run-threat-model-check.ts <manifest.json>");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
	assert(manifest.version === 1 && Array.isArray(manifest.checks), "Invalid threat-model manifest");
	const ids = new Set<string>();
	for (const check of manifest.checks) {
		assert(
			typeof check.id === "string" && check.id.length > 0 && !ids.has(check.id),
			"Invalid or duplicate check id",
		);
		assert(
			typeof check.description === "string" && (check.kind === "assertion" || check.kind === "negative-test"),
			`Invalid check ${check.id}`,
		);
		ids.add(check.id);
	}

	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-threat-model-"));
	const broker = new Broker({ agentDir, packageGeneration: "threat-model" });
	const failures: string[] = [];
	try {
		const discovery = await broker.start();
		await getBrokerIdentityKey(agentDir);
		const statusOutput = JSON.stringify(broker.status());
		const checks: Record<string, () => Promise<void>> = {
			"broker-token-agent-global-blast-radius": async () => {
				assert(discovery.token.length === 64, "broker token is not a 256-bit value");
			},
			"broker-discovery-file-permissions": async () => {
				if (process.platform !== "win32") {
					assert((await mode(brokerDiscoveryPath(agentDir))) === 0o600, "broker.json is not mode 0600");
					assert((await mode(path.join(agentDir, "sdk"))) === 0o700, "sdk directory is not mode 0700");
				}
			},
			"broker-identity-file-permissions": async () => {
				if (process.platform !== "win32")
					assert((await mode(brokerIdentityPath(agentDir))) === 0o600, "broker.identity is not mode 0600");
			},
			"broker-loopback-only": async () => {
				assert(discovery.host === "127.0.0.1", "broker advertised a non-loopback host");
				assert(discovery.url === `ws://127.0.0.1:${discovery.port}`, "broker advertised a non-loopback URL");
			},
			"broker-token-rotation-on-stale-takeover": async () => {
				const takeoverDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-takeover-"));
				const first = new Broker({ agentDir: takeoverDir, packageGeneration: "threat-model" });
				try {
					const previous = await first.start();
					await first.stop();
					const replacement = new Broker({ agentDir: takeoverDir, packageGeneration: "threat-model" });
					try {
						const next = await replacement.start();
						assert(next.token !== previous.token, "broker token did not rotate on takeover");
					} finally {
						await replacement.stop();
					}
				} finally {
					await first.stop();
					await fs.rm(takeoverDir, { recursive: true, force: true });
				}
			},
			"broker-per-session-token-separation": async () => {
				const sessionRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-session-token-"));
				const sessionToken = "session-token-that-must-not-authorize-broker";
				const sessionServer = new NotificationServer("threat-model", sessionToken, sessionRoot, true);
				try {
					const endpoint = await sessionServer.start();
					assert(endpoint.url.startsWith("ws://127.0.0.1:"), "per-session endpoint did not start on loopback");
					await rejectedWebSocket(`${discovery.url}/?token=${encodeURIComponent(sessionToken)}`);
				} finally {
					sessionServer.stop();
					await fs.rm(sessionRoot, { recursive: true, force: true });
				}
			},
			"broker-status-token-redaction": async () => {
				assert(!statusOutput.includes(discovery.token), "broker token appeared in production status output");
				assert(statusOutput.includes("[redacted]"), "production status output did not redact broker token");
			},
			"broker-non-loopback-negative-test": async () => {
				assert(!discovery.url.includes("0.0.0.0"), "non-loopback broker URL exists");
				await rejectedWebSocket(`${discovery.url}/?token=wrong-token`);
			},
		};
		for (const check of manifest.checks) {
			try {
				const run = checks[check.id];
				assert(run, `No implementation for check ${check.id}`);
				await run();
				console.log(`PASS ${check.id}`);
			} catch (error) {
				failures.push(check.id);
				console.error(`FAIL ${check.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
	if (failures.length) {
		process.stderr.write(`Failed threat-model checks: ${failures.join(", ")}\n`);
		process.exitCode = 1;
	}
}

await main();
