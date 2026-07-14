import { Container, PET_SKIN_IDS, PET_SKINS, SelectList } from "@gajae-code/tui";
import { getSelectListTheme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import type { PetMode } from "./gajae-pet-widget";
import { createPetSelectItems } from "./pet-capability";

const PET_OPTIONS: { value: PetMode; label: string; description: string }[] = [
	{ value: "off", label: "Off", description: "No pet" },
	...PET_SKIN_IDS.map(id => ({
		value: id,
		label: PET_SKINS[id].label,
		description: PET_SKINS[id].description,
	})),
];

/**
 * Theme-style picker for the gajae pet skin (Off / RedGajae / BlueGajae). Preview
 * fires as the selection moves; select commits, cancel restores.
 */
export class PetSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		current: PetMode,
		onSelect: (mode: PetMode) => void,
		onCancel: () => void,
		onPreview: (mode: PetMode) => void,
		available: boolean,
	) {
		super();

		const items = createPetSelectItems(PET_OPTIONS, current, available);

		this.addChild(new DynamicBorder());

		this.#selectList = new SelectList(items, 10, getSelectListTheme());
		const currentIndex = PET_OPTIONS.findIndex(option => option.value === current);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => onSelect(item.value as PetMode);
		this.#selectList.onCancel = () => onCancel();
		this.#selectList.onSelectionChange = item => onPreview(item.value as PetMode);

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
