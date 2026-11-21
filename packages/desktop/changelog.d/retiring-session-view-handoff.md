### Fixed
- Fence late workspace-close view saves against successor owners and persist the SDK-settled exact view before disposal while a terminal delivery receipt is still pending, preserving close budgets, root selections, failure propagation, and rolled-back publication ownership.
- Keep pending UI questions bound to their exact live owner so a retired request finishing late cannot cancel a reopened conversation's question; current-owner and global shutdown cleanup remain intact.
