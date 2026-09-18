import type { Broker } from "./broker";

/** Wait for broker-local completion and report successful completion to the executable boundary. */
export async function completeBrokerProcess(
	broker: Broker,
	setExitCode: (code: number) => void = code => {
		process.exitCode = code;
	},
): Promise<void> {
	await broker.completion;
	setExitCode(0);
}
