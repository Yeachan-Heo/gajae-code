### Fixed

- File locks on WSL DrvFS no longer strand their live owner after a directory rename commits but native verification cannot see the destination while retaining its source handle. Acquisition and detached release reconcile only against their original complete tree identity and content evidence; ambiguous results, replaced trees, and foreign locks remain protected.
- File-lock publication now requires successful native receipts to name the exact invoked operation before admitting protected work. Recognized but inapplicable primitives cannot authorize acquisition or trigger a publication retry (#5437).
