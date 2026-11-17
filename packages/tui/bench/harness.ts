/**
 * Benchmark timer shared by the tui bench scripts. `iterations` stays per
 * script so each benchmark keeps its own sampling budget.
 */
export function createBench(iterations: number): (name: string, fn: () => void) => number {
	return (name, fn) => {
		const start = Bun.nanoseconds();
		for (let i = 0; i < iterations; i++) {
			fn();
		}
		const elapsed = (Bun.nanoseconds() - start) / 1e6;
		const perOp = (elapsed / iterations).toFixed(6);
		console.log(`${name}: ${elapsed.toFixed(2)}ms total (${perOp}ms/op)`);
		return elapsed;
	};
}
