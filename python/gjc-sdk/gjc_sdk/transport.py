from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Sequence
from importlib import import_module
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# websockets 13 moved the asyncio client API; retain the 12-era import for the
# frozen >=12,<14 dependency range.
try:
    _connect: Any = import_module("websockets.asyncio.client").connect
except ModuleNotFoundError:
    _connect = import_module("websockets.client").connect


class Transport(Protocol):
    async def send_text(self, text: str) -> None: ...
    async def receive_text(self) -> str: ...
    async def close(self) -> None: ...


class AuthFailed(Exception):
    pass


class _LineReader:
    def __init__(self, stream: asyncio.StreamReader) -> None:
        self._stream = stream
        self._buffer = bytearray()

    async def read_line(self) -> bytes:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._buffer[:newline])
                del self._buffer[: newline + 1]
                return line
            chunk = await self._stream.read(64 * 1024)
            if not chunk:
                if self._buffer:
                    line = bytes(self._buffer)
                    self._buffer.clear()
                    return line
                return b""
            self._buffer.extend(chunk)


class WsTransport:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    @classmethod
    async def connect(cls, url: str, token: str) -> "WsTransport":
        parts = urlsplit(url)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query["token"] = token
        connection = await _connect(
            urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)),
            max_size=None,
        )
        return cls(connection)

    async def send_text(self, text: str) -> None:
        await self._connection.send(text)

    async def receive_text(self) -> str:
        message = await self._connection.recv()
        if not isinstance(message, str):
            raise ValueError("binary SDK frame")
        return message

    async def close(self) -> None:
        await self._connection.close()


class SocketTransport:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = _LineReader(reader)
        self._writer = writer
        self._first_receive = True

    @classmethod
    async def connect(cls, socket_path: str, token: str) -> "SocketTransport":
        reader, writer = await asyncio.open_unix_connection(socket_path)
        writer.write(f"gjc-sdk-transport/1 token={token}\n".encode())
        await writer.drain()
        return cls(reader, writer)

    async def send_text(self, text: str) -> None:
        if "\n" in text:
            raise ValueError("socket frames must be single-line JSON")
        self._writer.write((text + "\n").encode())
        await self._writer.drain()

    async def receive_text(self) -> str:
        line = await self._reader.read_line()
        if not line:
            raise EOFError("socket closed")
        text = line.decode()
        if self._first_receive:
            self._first_receive = False
            if text == '{"type":"transport_error","code":"auth_failed"}':
                await self.close()
                raise AuthFailed("socket authentication failed")
        return text

    async def close(self) -> None:
        self._writer.close()
        await self._writer.wait_closed()


class StdioTransport:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("stdio process pipes unavailable")
        self._process = process
        self._stdin = process.stdin
        self._stdout = _LineReader(process.stdout)
        self.stderr: deque[str] = deque(maxlen=64)
        self._stderr_task = asyncio.create_task(self._capture_stderr(process.stderr))

    @classmethod
    async def connect(cls, session_id: str, argv: Sequence[str] | None = None) -> "StdioTransport":
        command = list(argv) if argv is not None else ["gjc", "sdk", "serve", "--stdio", "--session", session_id]
        process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        return cls(process)

    async def _capture_stderr(self, stream: asyncio.StreamReader | None) -> None:
        if stream is None:
            return
        while line := await stream.readline():
            self.stderr.append(line.decode(errors="replace").rstrip("\n"))

    async def send_text(self, text: str) -> None:
        if "\n" in text:
            raise ValueError("stdio frames must be single-line JSON")
        self._stdin.write((text + "\n").encode())
        await self._stdin.drain()

    async def receive_text(self) -> str:
        line = await self._stdout.read_line()
        if not line:
            raise EOFError("stdio process closed")
        return line.decode()

    async def close(self) -> None:
        if self._process.returncode is None:
            self._process.terminate()
        await self._process.wait()
        self._stderr_task.cancel()
        await asyncio.gather(self._stderr_task, return_exceptions=True)
