/** Render deterministic capabilities exposed by the M1 memory package. */
import { memoryCapabilities } from "@gajae-code/memory-core";

export interface MemoryCapabilitiesCommandFlags {
	json?: boolean;
}

function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

export function runCapabilitiesCommand(flags: MemoryCapabilitiesCommandFlags = {}): void {
	const capabilities = memoryCapabilities();
	if (flags.json) {
		writeStdout(JSON.stringify(capabilities, null, 2));
		return;
	}

	writeStdout(`Memory capabilities (${capabilities.schemaVersion})`);
	writeStdout(`Package: @gajae-code/memory-core ${capabilities.packageVersion}`);
	writeStdout(`Milestone: ${capabilities.milestone}`);
	writeStdout(`Commands: ${capabilities.commands.join(", ")}`);
	writeStdout(`Agent tools: ${capabilities.agentTools.join(", ")}`);
	writeStdout(`Absent optional features: ${capabilities.absentOptionalFeatures.join(", ")}`);
}
