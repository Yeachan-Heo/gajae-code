/**
 * Idle CPU ceiling for interactive TUI sessions.
 *
 * 2026-10-23 measurement: 16 interactive sessions at 259% combined
 * CPU and 10.6GB RSS while all of them were idle at the prompt — roughly 16%
 * per session. A session that is waiting for input must cost near zero CPU, so
 * the ceiling below is deliberately tight: exceeding it means something started
 * repainting, polling, or animating without user-visible work.
 *
 * CPU is derived from cumulative `ps -o time=` deltas rather than `ps -o %cpu`,
 * which reports a lifetime average and therefore cannot show an idle spin that
 * started late in a long session.
 *
 * Usage:
 *   bun scripts/measure-idle-cpu.ts --pid 1234 --seconds 600
 *   bun scripts/measure-idle-cpu.ts --pids 1234,5678 --seconds 60 --json
 *
 * The default window matches the documented protocol: ten minutes of
 * untouched idle. Exit code 1 means at least one session exceeded the ceiling.
 */

export const DEFAULT_IDLE_WINDOW_SECONDS = 600;
export const DEFAULT_SAMPLE_INTERVAL_SECONDS = 10;
export const DEFAULT_MAX_IDLE_CPU_PERCENT = 3;
/** Below this the timer itself becomes the load we are trying to measure. */
export const MIN_SAMPLE_INTERVAL_SECONDS = 1;

const USAGE = `usage: bun scripts/measure-idle-cpu.ts --pid <pid>[,<pid>...] [options]

Samples cumulative \`ps -o time=\` deltas per session over a window and fails
(exit 1) when p95 CPU exceeds the ceiling.

  --pid, --pids <pids>   comma-separated session pids (required)
  --seconds <n>          measurement window (default ${DEFAULT_IDLE_WINDOW_SECONDS})
  --interval <n>         sample interval in seconds (default ${DEFAULT_SAMPLE_INTERVAL_SECONDS}, min ${MIN_SAMPLE_INTERVAL_SECONDS})
  --max-percent <n>      idle CPU ceiling per session (default ${DEFAULT_MAX_IDLE_CPU_PERCENT})
  --json                 print machine-readable results
  -h, --help             print this usage`;

export interface IdleCpuSummary {
	samples: number[];
	median: number;
	p95: number;
	max: number;
	exceeded: boolean;
}

export interface IdleCpuCliOptions {
	pids: number[];
	seconds: number;
	intervalSeconds: number;
	maxPercent: number;
	json: boolean;
	help: boolean;
}

/** Seconds of CPU consumed since process start, as printed by `ps -o time=`. */
export function parseCpuTime(raw: string): number | undefined {
	const text = raw.trim();
	if (!text) return undefined;
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match;
	if (hours !== undefined && minutes === undefined) return undefined;
	if (minutes === undefined || seconds === undefined) return undefined;
	const dayPart = days === undefined ? 0 : Number(days) * 86_400;
	const hourPart = hours === undefined ? 0 : Number(hours) * 3_600;
	const minutePart = Number(minutes) * 60;
	const secondPart = Number(seconds);
	const total = dayPart + hourPart + minutePart + secondPart;
	return Number.isFinite(total) ? total : undefined;
}

/** CPU percent of one core, from a cumulative-time delta over a wall window. */
export function cpuPercent(cpuSeconds: number, wallSeconds: number): number {
	if (!(wallSeconds > 0)) return 0;
	return (cpuSeconds / wallSeconds) * 100;
}

export function summarizeIdleCpu(samples: number[], maxPercent: number): IdleCpuSummary {
	const sorted = [...samples].sort((a, b) => a - b);
	const pick = (fraction: number): number => {
		if (sorted.length === 0) return 0;
		const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
		return sorted[index] ?? 0;
	};
	return {
		samples: sorted,
		median: pick(0.5),
		p95: pick(0.95),
		max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0),
		// p95 rather than max: one sample can catch a resize, a repaint after a
		// terminal capability probe, or the tail of the startup burst.
		exceeded: sorted.length > 0 && pick(0.95) > maxPercent,
	};
}

export function parseIdleCpuArgs(argv: string[]): IdleCpuCliOptions {
	const options: IdleCpuCliOptions = {
		pids: [],
		seconds: DEFAULT_IDLE_WINDOW_SECONDS,
		intervalSeconds: DEFAULT_SAMPLE_INTERVAL_SECONDS,
		maxPercent: DEFAULT_MAX_IDLE_CPU_PERCENT,
		json: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
			index += 1;
			return next;
		};
		switch (flag) {
			case "--pid":
			case "--pids": {
				for (const part of value().split(",")) {
					const pid = Number(part.trim());
					if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${part.trim()}`);
					options.pids.push(pid);
				}
				break;
			}
			case "--seconds": {
				const seconds = Number(value());
				if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds must be > 0");
				options.seconds = seconds;
				break;
			}
			case "--interval": {
				const interval = Number(value());
				if (!Number.isFinite(interval) || interval <= 0) throw new Error("--interval must be > 0");
				options.intervalSeconds = Math.max(MIN_SAMPLE_INTERVAL_SECONDS, interval);
				break;
			}
			case "--max-percent": {
				const max = Number(value());
				if (!Number.isFinite(max) || max < 0) throw new Error("--max-percent must be >= 0");
				options.maxPercent = max;
				break;
			}
			case "--json":
				options.json = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${flag}`);
		}
	}
	if (!options.help && options.pids.length === 0) throw new Error("at least one --pid is required");
	return options;
}

function readCpuSeconds(pid: number): number | undefined {
	const result = Bun.spawnSync({ cmd: ["ps", "-o", "time=", "-p", String(pid)], stdout: "pipe", stderr: "ignore" });
	if (result.exitCode !== 0) return undefined;
	return parseCpuTime(result.stdout.toString());
}

function readCommand(pid: number): string {
	const result = Bun.spawnSync({ cmd: ["ps", "-o", "args=", "-p", String(pid)], stdout: "pipe", stderr: "ignore" });
	if (result.exitCode !== 0) return "(gone)";
	const args = result.stdout.toString().trim();
	return args.length > 100 ? `${args.slice(0, 100)}…` : args || "(unknown)";
}

interface SessionResult {
	pid: number;
	command: string;
	summary: IdleCpuSummary | undefined;
	reason?: string;
}

const main = async (): Promise<number> => {
	const options = parseIdleCpuArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	const started = new Map<number, number>();
	for (const pid of options.pids) {
		const cpu = readCpuSeconds(pid);
		if (cpu === undefined) throw new Error(`process ${pid} is not running`);
		started.set(pid, cpu);
	}

	const samples = new Map<number, number[]>(options.pids.map(pid => [pid, []]));
	const lastCpu = new Map(started);
	const deadline = Date.now() + options.seconds * 1000;
	while (Date.now() < deadline) {
		await Bun.sleep(options.intervalSeconds * 1000);
		for (const pid of options.pids) {
			const cpu = readCpuSeconds(pid);
			const previous = lastCpu.get(pid);
			if (cpu === undefined || previous === undefined) continue;
			lastCpu.set(pid, cpu);
			samples.get(pid)?.push(cpuPercent(cpu - previous, options.intervalSeconds));
		}
	}

	const results: SessionResult[] = options.pids.map(pid => {
		const observed = samples.get(pid) ?? [];
		if (observed.length === 0) return { pid, command: readCommand(pid), summary: undefined, reason: "no samples" };
		return { pid, command: readCommand(pid), summary: summarizeIdleCpu(observed, options.maxPercent) };
	});

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					windowSeconds: options.seconds,
					intervalSeconds: options.intervalSeconds,
					maxIdleCpuPercent: options.maxPercent,
					sessions: results.map(result => ({
						pid: result.pid,
						command: result.command,
						reason: result.reason,
						...(result.summary
							? {
									median: Number(result.summary.median.toFixed(2)),
									p95: Number(result.summary.p95.toFixed(2)),
									max: Number(result.summary.max.toFixed(2)),
									samples: result.summary.samples.length,
									exceeded: result.summary.exceeded,
								}
							: {}),
					})),
				},
				null,
				2,
			),
		);
	} else {
		console.log(
			`idle CPU window ${options.seconds}s, sample interval ${options.intervalSeconds}s, ceiling ${options.maxPercent}% per session`,
		);
		for (const result of results) {
			if (!result.summary) {
				console.log(`pid ${result.pid}: ${result.reason ?? "no data"}`);
				continue;
			}
			const { median, p95, max, samples: observed, exceeded } = result.summary;
			console.log(
				`pid ${result.pid}: median ${median.toFixed(2)}% p95 ${p95.toFixed(2)}% max ${max.toFixed(2)}% (${observed.length} samples)${exceeded ? " EXCEEDED" : ""} — ${result.command}`,
			);
		}
	}

	return results.some(result => result.summary?.exceeded) ? 1 : 0;
};

if (import.meta.main) {
	try {
		process.exit(await main());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
}
