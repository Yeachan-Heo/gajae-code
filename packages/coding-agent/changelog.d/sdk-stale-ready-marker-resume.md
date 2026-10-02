### Fixed

- Fixed SDK session resume after a terminated host leaves its ready marker behind. The new host replaces the marker only when its owner is proven exited and its exact file identity still matches. Markers owned by live or uncertain processes remain protected. Regression from #5893.
