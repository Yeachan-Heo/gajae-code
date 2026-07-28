import type { KiroLoginMethod } from "@gajae-code/ai/utils/oauth/types";
import { Container, matchesKey, Spacer, TruncatedText } from "@gajae-code/tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

export type { KiroLoginMethod };

type KiroLoginMethodOption = {
	id: KiroLoginMethod;
	label: string;
};

const KIRO_LOGIN_METHODS: readonly KiroLoginMethodOption[] = [
	{ id: "google", label: "Google" },
	{ id: "github", label: "GitHub" },
	{ id: "builder-id", label: "AWS Builder ID" },
];

/** Selects the identity provider used to authenticate a Kiro account. */
export class KiroLoginMethodSelectorComponent extends Container {
	#listContainer: Container;
	#selectedIndex: number = 0;
	#onSelectCallback: (method: KiroLoginMethod) => void;
	#onCancelCallback: () => void;

	constructor(onSelect: (method: KiroLoginMethod) => void, onCancel: () => void) {
		super();
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Select Kiro login method:")));
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();
		for (const [index, method] of KIRO_LOGIN_METHODS.entries()) {
			const line =
				index === this.#selectedIndex
					? theme.fg("accent", `${theme.nav.cursor} ${method.label}`)
					: `  ${method.label}`;
			this.#listContainer.addChild(new TruncatedText(line, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? KIRO_LOGIN_METHODS.length - 1 : this.#selectedIndex - 1;
			this.#updateList();
		} else if (matchesKey(keyData, "down")) {
			this.#selectedIndex = (this.#selectedIndex + 1) % KIRO_LOGIN_METHODS.length;
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedMethod = KIRO_LOGIN_METHODS[this.#selectedIndex];
			if (selectedMethod) this.#onSelectCallback(selectedMethod.id);
		} else if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
		}
	}
}
