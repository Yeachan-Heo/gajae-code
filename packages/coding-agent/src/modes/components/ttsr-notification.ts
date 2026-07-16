import { Box, Container, Spacer, Text } from "@gajae-code/tui";
import type { Rule } from "../../capability/rule";
import { theme } from "../../modes/theme/theme";
import type { ExpandHintCapability } from "../../tools/render-utils";
import { expandHintSuffix } from "../../tools/render-utils";

/**
 * Component that renders a TTSR (Time Traveling Stream Rules) notification.
 * Shows when a rule violation is detected and the stream is being rewound.
 */
export class TtsrNotificationComponent extends Container {
	#box: Box;
	#expanded = false;

	constructor(
		private readonly rules: Rule[],
		private readonly expandHintCapability?: ExpandHintCapability,
	) {
		super();

		this.addChild(new Spacer(1));

		// Use inverse warning color for yellow background effect
		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.addChild(this.#box);

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	#rebuild(): void {
		this.#box.clear();

		// Build header: warning symbol + rule name + rewind icon
		const ruleNames = this.rules.map(r => theme.bold(r.name)).join(", ");
		const label = this.rules.length === 1 ? "rule" : "rules";
		const header = `${theme.icon.warning} Injecting ${label}: ${ruleNames}`;

		// Create header with rewind icon on the right
		const rewindIcon = theme.icon.rewind;

		this.#box.addChild(new Text(`${header}  ${rewindIcon}`, 0, 0));

		// Show description(s) - italic and truncated
		for (const rule of this.rules) {
			const desc = rule.description || rule.content;
			if (desc) {
				this.#box.addChild(new Spacer(1));

				let displayText = desc.trim();
				if (!this.#expanded) {
					// Truncate to first 2 lines
					const lines = displayText.split("\n");
					if (lines.length > 2) {
						displayText = `${lines.slice(0, 2).join("\n")}…`;
					}
				}

				// Use italic for subtle distinction (fg colors conflict with inverse)
				this.#box.addChild(new Text(theme.italic(displayText), 0, 0));
			}
		}

		// Show expand hint if collapsed and there's more content
		if (!this.#expanded) {
			const hasMoreContent = this.rules.some(r => {
				const desc = r.description || r.content;
				return desc && desc.split("\n").length > 2;
			});
			if (hasMoreContent) {
				this.#box.addChild({
					render: () => [theme.italic(expandHintSuffix(theme, this.expandHintCapability!))],
					invalidate: () => {},
				});
			}
		}
	}
}
