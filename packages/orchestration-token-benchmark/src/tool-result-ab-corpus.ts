/**
 * Deterministic workspace and task set for the live tool-result A/B (#5945).
 *
 * Large files invite bare-path reads and repeated identifiers invite wide search fan-out,
 * matching the issue's traffic. Each task has one planted answer, so no judge is needed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AbTask {
	id: string;
	prompt: string;
	/** Case-sensitive token the final answer must contain. */
	expect: string;
}

const MODULES = ["billing", "catalog", "gateway", "ledger", "orders", "payments", "search", "shipping"] as const;
const FILLER_FUNCTIONS = 180;

function fillerFunction(module: string, index: number): string {
	return [
		`/** Normalizes ${module} record ${index} before persistence. */`,
		`export function normalize_${module}_${index}(input: Record<string, unknown>): Record<string, unknown> {`,
		`\tconst trace = \`${module}:${index}:\${Object.keys(input).length}\`;`,
		`\tif (input.retryBudget === undefined) input.retryBudget = ${(index * 7) % 13};`,
		"\treturn { ...input, trace };",
		"}",
		"",
	].join("\n");
}

function moduleSource(module: string, position: number): string {
	const lines: string[] = [`// ${module} service module (generated benchmark corpus)`, ""];
	for (let i = 0; i < FILLER_FUNCTIONS; i++) {
		lines.push(fillerFunction(module, i));
		if (i === 120 + position) {
			lines.push(`export const ${module.toUpperCase()}_RETRY_CEILING = ${1000 + position * 37};`, "");
		}
	}
	lines.push(`export const ${module.toUpperCase()}_OWNER = "team-${module}-${position * 11 + 3}";`, "");
	return lines.join("\n");
}

function configSource(): string {
	const lines = ["# gateway runtime configuration (generated benchmark corpus)", ""];
	for (let i = 0; i < 400; i++) {
		lines.push(`upstream_${i}_timeout_ms = ${200 + ((i * 17) % 900)}`);
		if (i === 333) lines.push("circuit_breaker_cooldown_ms = 45250");
	}
	return `${lines.join("\n")}\n`;
}

export async function writeAbCorpus(root: string): Promise<void> {
	await fs.mkdir(path.join(root, "src"), { recursive: true });
	await Promise.all(
		MODULES.map((module, position) =>
			Bun.write(path.join(root, "src", `${module}.ts`), moduleSource(module, position)),
		),
	);
	await Bun.write(path.join(root, "config", "gateway.toml"), configSource());
	await Bun.write(
		path.join(root, "README.md"),
		"# Benchmark corpus\n\nServices live in `src/`; runtime configuration lives in `config/`.\n",
	);
}

export const AB_TASKS: readonly AbTask[] = [
	{
		id: "retry-ceiling",
		prompt: "What numeric value is LEDGER_RETRY_CEILING set to in this repository? Answer with the number.",
		expect: String(1000 + 3 * 37),
	},
	{
		id: "owner",
		prompt: "Which team string is exported as SHIPPING_OWNER? Answer with the exact string value.",
		expect: `team-shipping-${7 * 11 + 3}`,
	},
	{
		id: "config-cooldown",
		prompt: "In config/gateway.toml, what is circuit_breaker_cooldown_ms? Answer with the number.",
		expect: "45250",
	},
	{
		id: "fanout-count",
		prompt:
			"How many files under src/ define an exported constant whose name ends in _RETRY_CEILING? Answer with the count as a digit.",
		expect: String(MODULES.length),
	},
	{
		id: "function-body",
		prompt:
			"In src/payments.ts, what retryBudget default does normalize_payments_150 assign? Answer with the number.",
		expect: String((150 * 7) % 13),
	},
] as const;

/** Success when the final answer contains the planted value as a standalone token. */
export function answerMatches(answer: string | undefined, expected: string): boolean {
	if (!answer) return false;
	const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^0-9A-Za-z_-])${escaped}($|[^0-9A-Za-z_-])`).test(answer);
}
