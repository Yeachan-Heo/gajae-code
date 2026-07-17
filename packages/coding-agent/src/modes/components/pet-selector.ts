import { Container, PET_SKIN_IDS, PET_SKINS, type SelectList } from "@gajae-code/tui";
import { FramedSelect } from "./chrome";
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

		const framed = FramedSelect(undefined, items, {
			maxVisible: 10,
			selectedValue: current,
			onSelect: item => onSelect(item.value as PetMode),
			onCancel,
			onSelectionChange: item => onPreview(item.value as PetMode),
		});
		this.#selectList = framed.selectList;
		this.addChild(framed.container);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
