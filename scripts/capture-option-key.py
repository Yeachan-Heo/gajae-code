#!/usr/bin/env python3
"""Print raw bytes received for one key at a time in an interactive tty."""

import sys
import termios
import tty

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    print("Press Option+Q or Option+I; press Ctrl-C to stop", flush=True)
    while True:
        value = sys.stdin.buffer.read(1)
        if not value:
            break
        if value == b"\x03":
            print("\nStopped.", flush=True)
            break
        print(f"\nbyte=0x{value[0]:02x}", flush=True)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
