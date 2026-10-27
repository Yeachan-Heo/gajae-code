### Fixed

- A `<lock>.removing` left by a lock owner that stamped no host id, such as a broker killed mid-release just before an upgrade, no longer blocks a host-qualified lock like the SDK session index forever. Its remover record stays foreign while the transition could still be in progress. Once the record and every captured entry have been unchanged for the orphan adoption age, the recorded pid is checked locally and a dead remover's transition is adopted. Records from another host, and records naming a live process, are still never reclaimed.
