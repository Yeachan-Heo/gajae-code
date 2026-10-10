### Fixed

- Plan mode refuses a `local://` write, link, or unlink unless the real path stays inside the real session local root, including a dangling symlink and an ordinary plan-file write through a symlink that leaves an explicit artifacts root.
