import * as os from "node:os";
import type { AgentMessage } from "@gajae-code/agent-core";
import { SecretObfuscator, type SecretEntry } from "../src/secrets/obfuscator";

const EQUALITY_WARMUP_ITERATIONS = 20;
const EQUALITY_MEASURE_ITERATIONS = 200;
// Heavy path: each measured obfuscator iteration scans/replaces 100 secrets in a 1MiB payload.
const OBFUSCATOR_WARMUP_ITERATIONS = 5;
const OBFUSCATOR_MEASURE_ITERATIONS = 50;

type Summary = { median: number; p95: number; p99: number; min: number; max: number };
type BenchOutput = {
	metadata: { timestamp: string; platform: string; arch: string; cpus: number; note: string };
	iterations: { equalityWarmup: number; equalityMeasured: number; obfuscatorWarmup: number; obfuscatorMeasured: number };
	summaries: Record<string, Summary>;
	baseline?: Record<string, Summary>;
	deltas?: Record<string, { median: number; p95: number; p99: number }>;
};

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function makeMessage(index: number): AgentMessage {
	return {
		role: index % 7 === 0 ? "assistant" : "user",
		content: index % 7 === 0
			? [{ type: "text", text: `assistant content ${index}`, textSignature: `sig-${index}` }]
			: [{ type: "text", text: `user content ${index}` }],
		api: index % 7 === 0 ? "openai-responses" : undefined,
		provider: index % 7 === 0 ? "openai" : undefined,
		model: index % 7 === 0 ? "gpt" : undefined,
		timestamp: index,
	} as AgentMessage;
}

function normalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => normalizeValue(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, normalizeValue(entryValue)]));
	return value;
}

function normalizeMessage(message: AgentMessage): unknown {
	switch (message.role) {
		case "user":
		case "developer":
			return { role: message.role, content: normalizeValue(message.content), providerPayload: message.providerPayload };
		case "assistant": {
			const isResponsesFamilyMessage = message.api === "openai-responses" || message.api === "openai-codex-responses";
			return {
				role: message.role,
				content: isResponsesFamilyMessage && Array.isArray(message.content)
					? message.content.flatMap(block => {
							if (block.type === "thinking") return [];
							if (block.type === "toolCall") return [{ type: block.type, id: block.id, name: block.name, arguments: block.arguments }];
							if (block.type === "text") return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
							return [normalizeValue(block)];
						})
					: normalizeValue(message.content),
				api: message.api,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
			};
		}
		default:
			return normalizeValue(message);
	}
}

function oldDidMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
	return JSON.stringify(previousMessages.map(message => normalizeMessage(message))) !== JSON.stringify(nextMessages.map(message => normalizeMessage(message)));
}

function newDidMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[], cache = new WeakMap<AgentMessage, { source: string; hash: bigint }>()): boolean {
	const sourceFor = (message: AgentMessage): { source: string; hash: bigint } => {
		const cached = cache.get(message);
		if (cached) return cached;
		const source = JSON.stringify(normalizeMessage(message));
		const entry = { source, hash: Bun.hash.xxHash64(source) };
		cache.set(message, entry);
		return entry;
	};
	if (previousMessages.length !== nextMessages.length) return true;
	const previousSources: Array<{ source: string; hash: bigint }> = [];
	const nextSources: Array<{ source: string; hash: bigint }> = [];
	for (let i = 0; i < previousMessages.length; i++) {
		const previous = sourceFor(previousMessages[i]!);
		const next = sourceFor(nextMessages[i]!);
		if (previous.hash !== next.hash) return true;
		previousSources.push(previous);
		nextSources.push(next);
	}
	for (let i = 0; i < previousSources.length; i++) if (previousSources[i]!.source !== nextSources[i]!.source) return true;
	return false;
}

function oldObfuscate(entries: SecretEntry[], text: string): string {
	let result = text;
	const replaceMappings = new Map<string, string>();
	const obfuscateMappings = new Map<string, string>();
	const hashChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const placeholder = (index: number): string => {
		let v = Bun.hash.xxHash32(String(index), 0x5345_4352);
		let tag = "#";
		for (let i = 0; i < 4; i++) {
			tag += hashChars[v % hashChars.length];
			v = Math.floor(v / hashChars.length);
		}
		return `${tag}#`;
	};
	let index = 0;
	for (const entry of entries) {
		if (entry.type !== "plain") continue;
		if ((entry.mode ?? "obfuscate") === "replace") replaceMappings.set(entry.content, entry.replacement ?? entry.content);
		else obfuscateMappings.set(entry.content, placeholder(index++));
	}
	for (const mapping of [...replaceMappings].sort((a, b) => b[0].length - a[0].length)) result = result.split(mapping[0]).join(mapping[1]);
	for (const mapping of [...obfuscateMappings].sort((a, b) => b[0].length - a[0].length)) result = result.split(mapping[0]).join(mapping[1]);
	return result;
}

function summary(samples: number[]): Summary {
	const sorted = [...samples].sort((a, b) => a - b);
	const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
	return { median: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), min: sorted[0]!, max: sorted.at(-1)! };
}

function bench(name: string, warmup: number, measured: number, fn: () => void, samples: Record<string, number[]>): void {
	for (let i = 0; i < warmup; i++) fn();
	samples[name] = [];
	for (let i = 0; i < measured; i++) {
		const start = performance.now();
		fn();
		samples[name]!.push(performance.now() - start);
	}
}

const messages = Array.from({ length: 1000 }, (_, i) => makeMessage(i));
const changedAtStart = messages.slice();
changedAtStart[0] = { role: "user", content: "changed", timestamp: 0 } as AgentMessage;
const changedAtEnd = messages.slice();
changedAtEnd[changedAtEnd.length - 1] = { role: "user", content: "changed", timestamp: 999 } as AgentMessage;
const sharedCache = new WeakMap<AgentMessage, { source: string; hash: bigint }>();
const secretEntries: SecretEntry[] = Array.from({ length: 100 }, (_, i) => ({ type: "plain", content: `secret-${i.toString().padStart(3, "0")}`, mode: i % 5 === 0 ? "replace" : "obfuscate", replacement: `replacement-${i}` }));
const obfuscator = new SecretObfuscator(secretEntries);
const textChunks: string[] = [];
let textBytes = 0;
for (let i = 0; textBytes < 1024 * 1024; i++) {
	const secret = i < secretEntries.length ? ` ${secretEntries[i]!.content} ` : "";
	const chunk = `filler-${i.toString(36).padStart(6, "0")}${secret}${"x".repeat(180)}\n`;
	textChunks.push(chunk);
	textBytes += Buffer.byteLength(chunk);
}
const oneMiBText = textChunks.join("").slice(0, 1024 * 1024);

const samples: Record<string, number[]> = {};
bench("equality-old-unchanged", EQUALITY_WARMUP_ITERATIONS, EQUALITY_MEASURE_ITERATIONS, () => { oldDidMessagesChange(messages, messages); }, samples);
bench("equality-new-unchanged", EQUALITY_WARMUP_ITERATIONS, EQUALITY_MEASURE_ITERATIONS, () => { newDidMessagesChange(messages, messages, sharedCache); }, samples);
bench("equality-new-changed-start", EQUALITY_WARMUP_ITERATIONS, EQUALITY_MEASURE_ITERATIONS, () => { newDidMessagesChange(messages, changedAtStart, sharedCache); }, samples);
bench("equality-new-changed-end", EQUALITY_WARMUP_ITERATIONS, EQUALITY_MEASURE_ITERATIONS, () => { newDidMessagesChange(messages, changedAtEnd, sharedCache); }, samples);
bench("obfuscator-old-100x1mib", OBFUSCATOR_WARMUP_ITERATIONS, OBFUSCATOR_MEASURE_ITERATIONS, () => { oldObfuscate(secretEntries, oneMiBText); }, samples);
bench("obfuscator-new-100x1mib", OBFUSCATOR_WARMUP_ITERATIONS, OBFUSCATOR_MEASURE_ITERATIONS, () => { obfuscator.obfuscate(oneMiBText); }, samples);

const summaries = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summary(values)]));
const output: BenchOutput = {
	metadata: { timestamp: new Date().toISOString(), platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, note: "In-process A/B harness: old sequential obfuscator and old JSON equality run beside new implementations over identical fixtures." },
	iterations: { equalityWarmup: EQUALITY_WARMUP_ITERATIONS, equalityMeasured: EQUALITY_MEASURE_ITERATIONS, obfuscatorWarmup: OBFUSCATOR_WARMUP_ITERATIONS, obfuscatorMeasured: OBFUSCATOR_MEASURE_ITERATIONS },
	summaries,
};
const baselinePath = argValue("--baseline");
if (baselinePath) {
	const baseline = JSON.parse(await Bun.file(baselinePath).text()) as BenchOutput;
	output.baseline = baseline.summaries;
	output.deltas = Object.fromEntries(Object.entries(summaries).filter(([name]) => baseline.summaries[name]).map(([name, value]) => {
		const b = baseline.summaries[name]!;
		return [name, { median: (value.median - b.median) / b.median, p95: (value.p95 - b.p95) / b.p95, p99: (value.p99 - b.p99) / b.p99 }];
	}));
}
const outPath = argValue("--out");
if (outPath) await Bun.write(outPath, `${JSON.stringify(output, null, "\t")}\n`);
else console.log(JSON.stringify(output, null, "\t"));
