import type { PythonKernelExecutor } from "@gajae-code/coding-agent/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@gajae-code/coding-agent/eval/py/kernel";

export class FakeKernel implements PythonKernelExecutor {
	id = `fake-kernel-${Math.random().toString(36).slice(2)}`;
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => Promise<void> | void;
	#exitCode: number | null = null;

	constructor(result: KernelExecuteResult, onExecute: (options?: KernelExecuteOptions) => Promise<void> | void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		await this.onExecute(options);
		return this.result;
	}

	getExitCode(): number | null {
		return this.#exitCode;
	}

	setExitCode(code: number | null): void {
		this.#exitCode = code;
	}
}
