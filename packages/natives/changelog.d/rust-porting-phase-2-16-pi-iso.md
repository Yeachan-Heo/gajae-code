### Changed

- Native isolation now exposes selective copy-on-write tree cloning for APFS, Linux FICLONE, and Windows block-clone backends. Unsupported backends report an explicit unavailable error; local Windows dependency features and secure plain-tree diff traversal remain intact.
