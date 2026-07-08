Runs commands on remote hosts.

<instruction>
You MUST build commands from the reference below.
The local coreutils restrictions (`cat`/`grep`/`find`/`head`/`tail` bans) do NOT apply on remote hosts — `read`/`search`/`find` cannot reach them, so these shell commands are the only tools available there.
</instruction>

<commands>
**linux/bash, linux/zsh, macos/bash, macos/zsh** — Unix-like:
- Files: `ls`, `cat`, `head`, `tail`, `grep`, `find`
- System: `ps`, `top`, `df`, `uname` (all), `free` (Linux only)
- Navigation: `cd`, `pwd`
**windows/bash, windows/sh** — Windows Unix layer (WSL, Cygwin, Git Bash):
- Files/System/Navigation: same as Unix-like above, minus `free`
**windows/powershell** — PowerShell:
- Files: `Get-ChildItem`, `Get-Content`, `Select-String`
- System: `Get-Process`, `Get-ComputerInfo`
- Navigation: `Set-Location`, `Get-Location`
**windows/cmd** — Command Prompt:
- Files: `dir`, `type`, `findstr`, `where`
- System: `tasklist`, `systeminfo`
- Navigation: `cd`, `echo %CD%`
</commands>

<critical>
You MUST verify the shell type from "Available hosts" and use matching commands.
</critical>

<examples>
# List files: Linux
Host: server1 (10.0.0.1) | linux/bash. Command: `ls -la /home/user`
# Show running processes: Windows cmd
Host: winbox (192.168.1.5) | windows/cmd. Command: `tasklist /v`
# Get system info: macOS
Host: macbook (10.0.0.20) | macos/zsh. Command: `uname -a && sw_vers`
</examples>
