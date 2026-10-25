### Fixed

- A mouse drag selection that starts after other text on a padded row now highlights only the selected cells. The copied text was already correct, but the drag-origin marker was spliced in by slicing the painted row twice, which pulled the reverse-video escape into the prefix and highlighted from the start of the row.
