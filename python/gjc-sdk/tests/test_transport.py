from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

import pytest
from websockets.asyncio.server import serve

from gjc_sdk.transport import SocketTransport, StdioTransport, WsTransport


LONG_FRAME = '{"type":"action_needed","payload":"' + "x" * (1024 * 1024) + '"}'


@pytest.mark.asyncio
async def test_ws_transport_receives_frame_larger_than_one_megabyte() -> None:
    async def handler(websocket: object) -> None:
        await websocket.send(LONG_FRAME)  # type: ignore[union-attr]

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        transport = await WsTransport.connect(f"ws://127.0.0.1:{port}", "secret")
        try:
            assert await transport.receive_text() == LONG_FRAME
        finally:
            await transport.close()


@pytest.mark.asyncio
async def test_socket_transport_receives_frame_larger_than_one_megabyte() -> None:
    socket_path = Path(tempfile.mktemp(prefix="gjc-sdk-", dir="/tmp"))

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readline()
        writer.write(LONG_FRAME.encode() + b"\n")
        await writer.drain()
        writer.close()

    server = await asyncio.start_unix_server(handler, socket_path)
    transport = await SocketTransport.connect(str(socket_path), "secret")
    try:
        assert await transport.receive_text() == LONG_FRAME
    finally:
        await transport.close()
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_stdio_transport_receives_frame_larger_than_one_megabyte() -> None:
    command = [sys.executable, "-c", "import sys; sys.stdout.write('{\"type\":\"action_needed\",\"payload\":\"' + 'x' * 1048576 + '\"}\\n'); sys.stdout.flush()"]
    transport = await StdioTransport.connect("session", command)
    try:
        assert await transport.receive_text() == LONG_FRAME
    finally:
        await transport.close()
