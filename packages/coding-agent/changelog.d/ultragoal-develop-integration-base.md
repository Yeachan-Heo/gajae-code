### Fixed

- Recognize `develop` and `origin/develop` as authoritative Ultragoal integration bases while retaining nearest-merge-base selection. Exclude the checked-out local branch from default candidates so committed changes remain visible, and reject repositories without a distinct recognized base; explicit overrides and remote-tracking refs remain eligible.
