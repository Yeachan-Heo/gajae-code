import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	getPetPixelProtocol,
	PET_CAPABILITY_SETTLE_MS,
	warnWhenPetCapabilitySettled,
} from "@gajae-code/coding-agent/modes/components/pet-capability";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@gajae-code/tui";

const originalProtocol = TERMINAL.imageProtocol;
const multiplexerEnvKeys = [
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"GJC_TMUX_LAUNCHED",
	"TERM",
	"PI_FORCE_IMAGE_PROTOCOL",
	"GJC_FORCE_IMAGE_PROTOCOL",
] as const;
const originalMultiplexerEnv = new Map(multiplexerEnvKeys.map(key => [key, Bun.env[key]] as const));

const multiplexerCases = [
	["tmux", { TMUX: "/tmp/tmux-1000/default,1,0" }],
	["screen", { STY: "1234.pts-0.host" }],
	["zellij", { ZELLIJ: "session" }],
] as const;

function setForcedProtocol(protocol: "kitty" | "sixel", multiplexerEnv: Readonly<Record<string, string>>): void {
	for (const key of multiplexerEnvKeys) delete Bun.env[key];
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = protocol;
	for (const [key, value] of Object.entries(multiplexerEnv)) Bun.env[key] = value;
	setTerminalImageProtocol(protocol === "kitty" ? ImageProtocol.Kitty : ImageProtocol.Sixel);
}

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
	for (const key of multiplexerEnvKeys) {
		const value = originalMultiplexerEnv.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("getPetPixelProtocol", () => {
	for (const [name, multiplexerEnv] of multiplexerCases) {
		it(`keeps forced Kitty unavailable inside ${name}`, () => {
			setForcedProtocol("kitty", multiplexerEnv);

			expect(getPetPixelProtocol()).toBeNull();
		});

		it(`keeps forced Sixel available inside ${name}`, () => {
			setForcedProtocol("sixel", multiplexerEnv);

			expect(getPetPixelProtocol()).toBe("sixel");
		});
	}
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
