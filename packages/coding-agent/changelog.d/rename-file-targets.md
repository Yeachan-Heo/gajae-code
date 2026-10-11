### Fixed

- `lsp` `rename_file` checks the source, destination, and every `willRenameFiles` edit path with the existing workspace check before it writes any of them. A Windows drive root still allows that volume and rejects another drive or share. POSIX `/` stays unchecked.
