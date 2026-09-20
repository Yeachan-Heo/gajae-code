### Fixed

- Handled tool refusals, policy denials, command failures, and other designed outcomes no longer appear in the crash recorder. Unexpected tool failures retain their original error class and are fingerprinted by their failing frame so repeated failures deduplicate.
