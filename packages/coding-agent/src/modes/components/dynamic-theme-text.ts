import { type Component, Text } from "@gajae-code/tui";

/** Text whose styling is resolved at render time so live theme previews recolor open overlays. */
export class DynamicThemeText implements Component {
	#text = new Text("", 0, 0);
	#rendered = "";

	constructor(private readonly getText: () => string) {}

	invalidate(): void {
		this.#text.invalidate();
	}

	render(width: number): string[] {
		const rendered = this.getText();
		if (rendered !== this.#rendered) {
			this.#rendered = rendered;
			this.#text.setText(rendered);
		}
		return this.#text.render(width);
	}
}
