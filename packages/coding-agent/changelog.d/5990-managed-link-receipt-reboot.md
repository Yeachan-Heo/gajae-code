### Fixed

- `./install.sh --dev` and `gjc doctor` no longer treat this checkout's own `gjc` and `가재씨` links as foreign after a macOS reboot. The ownership receipt still binds the link by inode, but no longer compares the recorded `st_dev`, which APFS changes across boots. A receipt left behind after its link was removed by hand is recognized as this checkout's and replaced, while a receipt that names another checkout is refused before either link is touched.
