### Fixed

- Schema normalization for Cloud Code Assist (CCA) now correctly filters type-specific keys when collapsing mixed-type `anyOf` variants. Previously, when collapsing `anyOf: [{ type: "string", ... }, { type: "array", items: {...} }]` to a single type (string variant first), the collapsed schema would retain `items` from the array variant, resulting in invalid schemas with type-mismatched keys. The fix ensures only keys valid for the chosen type are carried forward (issue #7808).
