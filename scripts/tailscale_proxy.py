#!/usr/bin/env python3
"""Proxy TTM-Todo on the Tailscale IP only (not 0.0.0.0 / public)."""

from __future__ import annotations

import asyncio
import subprocess
import sys

UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = 8010
LISTEN_PORT = 8010


def tailscale_ips() -> list[str]:
    ips: list[str] = []
    for flag in ("-4", "-6"):
        try:
            out = subprocess.check_output(
                ["tailscale", "ip", flag], text=True, stderr=subprocess.DEVNULL
            ).strip()
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
        for line in out.splitlines():
            ip = line.strip()
            if ip:
                ips.append(ip)
    return ips


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        up_reader, up_writer = await asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT)
    except OSError:
        writer.close()
        await writer.wait_closed()
        return
    await asyncio.gather(
        pipe(reader, up_writer),
        pipe(up_reader, writer),
        return_exceptions=True,
    )


async def amain() -> int:
    ips: list[str] = []
    for _ in range(60):
        ips = tailscale_ips()
        if ips:
            break
        await asyncio.sleep(1)
    if not ips:
        print("tailscale IP not available", file=sys.stderr)
        return 1

    servers = []
    for ip in ips:
        try:
            servers.append(await asyncio.start_server(handle, ip, LISTEN_PORT))
            print(f"proxy {ip}:{LISTEN_PORT} -> {UPSTREAM_HOST}:{UPSTREAM_PORT}", flush=True)
        except OSError as exc:
            print(f"could not bind {ip}:{LISTEN_PORT}: {exc}", file=sys.stderr)

    if not servers:
        return 1

    await asyncio.gather(*(server.serve_forever() for server in servers))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain()))
