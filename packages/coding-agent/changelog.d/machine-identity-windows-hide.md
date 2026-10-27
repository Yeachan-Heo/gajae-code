### Fixed

- The Windows machine-identity probe (`reg query ... MachineGuid`) now runs with `windowsHide`, so the console-less detached broker no longer flashes a visible terminal window each time it derives the ownership-lock host identity.
