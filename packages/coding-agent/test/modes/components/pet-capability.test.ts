import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	PET_CAPABILITY_SETTLE_MS,
	warnWhenPetCapabilitySettled,
} from "@gajae-code/coding-agent/modes/components/pet-capability";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@gajae-code/tui";

const originalProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("warnWhenPetCapabilitySettled", () => {
	it("warns immediately when no probe can change the answer", () => {
		const onUnavailable = vi.fn();

		warnWhenPetCapabilitySettled({ probePending: false, onUnavailable });

		expect(onUnavailable).toHaveBeenCalledTimes(1);
	});

	it("never warns when the pending probe enables graphics before the deadline", () => {
		vi.useFakeTimers();
		setTerminalImageProtocol(null);
		const onUnavailable = vi.fn();

		const dispose = warnWhenPetCapabilitySettled({ probePending: true, onUnavailable });
		try {
			// Startup ordering: no warning may fire while the probe is in flight.
			expect(onUnavailable).not.toHaveBeenCalled();

			// The probe succeeds (e.g. Windows Terminal answering XTSMGRAPHICS).
			setTerminalImageProtocol(ImageProtocol.Sixel);
			vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS * 2);

			expect(onUnavailable).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("warns exactly once when the settle deadline passes with the terminal still unavailable", () => {
		vi.useFakeTimers();
		setTerminalImageProtocol(null);
		const onUnavailable = vi.fn();

		const dispose = warnWhenPetCapabilitySettled({ probePending: true, onUnavailable });
		try {
			expect(onUnavailable).not.toHaveBeenCalled();

			vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS * 2);

			expect(onUnavailable).toHaveBeenCalledTimes(1);
		} finally {
			dispose();
		}
	});

	it("stays silent when disposed before settlement", () => {
		vi.useFakeTimers();
		setTerminalImageProtocol(null);
		const onUnavailable = vi.fn();

		const dispose = warnWhenPetCapabilitySettled({ probePending: true, onUnavailable });
		dispose();
		vi.advanceTimersByTime(PET_CAPABILITY_SETTLE_MS * 2);

		expect(onUnavailable).not.toHaveBeenCalled();
	});
});
