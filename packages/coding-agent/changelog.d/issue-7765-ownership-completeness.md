### Fixed

- Windows: GJC no longer incorrectly terminates pre-existing processes when process identity resolution experiences a transient failure followed by recovery. The ownership descent walk now tracks whether all process identities were successfully resolved and returns an incomplete observation if any resolution fails in the descent chain, preventing unproven partial baselines from being cached as proven empty sets. ([#7765](https://github.com/Yeachan-Heo/gajae-code/issues/7765))
