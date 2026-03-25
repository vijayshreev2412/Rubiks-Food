#!/usr/bin/env python3
"""Replay lines from a source log file into a destination file."""

from __future__ import annotations

import argparse
import os
import socket
import time
from pathlib import Path
from typing import Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy log lines from SOURCE to DEST with a delay between lines."
    )
    parser.add_argument(
        "--source",
        required=True,
        help="Path to source log file (for example: ./lambda-lvmsa.log).",
    )
    parser.add_argument(
        "--dest",
        required=True,
        help="Path to destination log file (for example: ./destination.log).",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=2,
        help="How many times to replay the source file (default: 2).",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.10,
        help="Delay in seconds between each line write (default: 0.10).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite destination file instead of appending.",
    )
    parser.add_argument(
        "--dd-enabled",
        action="store_true",
        help="Send replay metrics to Datadog via DogStatsD.",
    )
    parser.add_argument(
        "--dd-host",
        default=os.getenv("DD_AGENT_HOST", "127.0.0.1"),
        help="DogStatsD host (default: DD_AGENT_HOST or 127.0.0.1).",
    )
    parser.add_argument(
        "--dd-port",
        type=int,
        default=int(os.getenv("DD_DOGSTATSD_PORT", "8125")),
        help="DogStatsD port (default: DD_DOGSTATSD_PORT or 8125).",
    )
    parser.add_argument(
        "--dd-prefix",
        default="log_replay",
        help="Datadog metric prefix (default: log_replay).",
    )
    parser.add_argument(
        "--dd-service",
        default=os.getenv("DD_SERVICE", "python-log-replay"),
        help="Datadog service tag value (default: python-log-replay).",
    )
    parser.add_argument(
        "--dd-env",
        default=os.getenv("DD_ENV"),
        help="Datadog env tag value (optional, default: DD_ENV).",
    )
    parser.add_argument(
        "--dd-version",
        default=os.getenv("DD_VERSION"),
        help="Datadog version tag value (optional, default: DD_VERSION).",
    )
    parser.add_argument(
        "--dd-tags",
        default="",
        help="Additional Datadog tags as comma-separated key:value pairs.",
    )
    return parser.parse_args()


def parse_tags(raw_tags: str) -> list[str]:
    return [tag.strip() for tag in raw_tags.split(",") if tag.strip()]


class DogStatsdClient:
    """Very small DogStatsD client to avoid external dependencies."""

    def __init__(
        self,
        *,
        enabled: bool,
        host: str,
        port: int,
        metric_prefix: str,
        default_tags: list[str],
    ) -> None:
        self.enabled = enabled
        self.host = host
        self.port = port
        self.metric_prefix = metric_prefix.strip(".")
        self.default_tags = default_tags
        self._warned = False
        self._socket: socket.socket | None = None
        if self.enabled:
            self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def _send(self, payload: str) -> None:
        if not self.enabled or self._socket is None:
            return
        try:
            self._socket.sendto(payload.encode("utf-8"), (self.host, self.port))
        except OSError as exc:
            if not self._warned:
                print(f"Warning: failed to send Datadog metrics: {exc}")
                self._warned = True

    def metric(
        self,
        name: str,
        value: float,
        metric_type: str,
        tags: Iterable[str] | None = None,
    ) -> None:
        metric_name = f"{self.metric_prefix}.{name}" if self.metric_prefix else name
        payload = f"{metric_name}:{value}|{metric_type}"
        merged_tags = [*self.default_tags, *(tags or [])]
        if merged_tags:
            payload = f"{payload}|#{','.join(merged_tags)}"
        self._send(payload)

    def increment(self, name: str, value: int = 1, tags: Iterable[str] | None = None) -> None:
        self.metric(name=name, value=value, metric_type="c", tags=tags)

    def gauge(self, name: str, value: float, tags: Iterable[str] | None = None) -> None:
        self.metric(name=name, value=value, metric_type="g", tags=tags)

    def histogram(self, name: str, value: float, tags: Iterable[str] | None = None) -> None:
        self.metric(name=name, value=value, metric_type="h", tags=tags)


def replay_log(
    source: Path,
    dest: Path,
    repeat: int,
    delay: float,
    overwrite: bool,
    statsd: DogStatsdClient,
) -> int:
    if repeat < 1:
        raise ValueError("--repeat must be at least 1")
    if delay < 0:
        raise ValueError("--delay must be >= 0")
    if not source.exists():
        raise FileNotFoundError(f"Source file not found: {source}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    mode = "w" if overwrite else "a"
    started_at = time.monotonic()
    lines_written = 0
    statsd.gauge("running", 1)
    statsd.gauge("repeat_target", repeat)
    statsd.gauge("delay_seconds", delay)

    try:
        with dest.open(mode, encoding="utf-8") as dest_handle:
            for iteration in range(repeat):
                with source.open("r", encoding="utf-8") as src_handle:
                    iteration_count = 0
                    for line in src_handle:
                        dest_handle.write(line)
                        dest_handle.flush()
                        lines_written += 1
                        iteration_count += 1
                        time.sleep(delay)
                statsd.increment("replay_runs_completed", 1, tags=[f"iteration:{iteration + 1}"])
                statsd.increment("lines_written", iteration_count, tags=[f"iteration:{iteration + 1}"])
        return lines_written
    finally:
        statsd.gauge("running", 0)
        statsd.histogram("runtime_seconds", time.monotonic() - started_at)


def main() -> None:
    args = parse_args()
    source = Path(args.source).expanduser()
    dest = Path(args.dest).expanduser()
    tags = [
        f"service:{args.dd_service}",
        f"source_file:{source.name}",
        f"dest_file:{dest.name}",
        *parse_tags(args.dd_tags),
    ]
    if args.dd_env:
        tags.append(f"env:{args.dd_env}")
    if args.dd_version:
        tags.append(f"version:{args.dd_version}")

    statsd = DogStatsdClient(
        enabled=args.dd_enabled,
        host=args.dd_host,
        port=args.dd_port,
        metric_prefix=args.dd_prefix,
        default_tags=tags,
    )
    try:
        lines_written = replay_log(
            source=source,
            dest=dest,
            repeat=args.repeat,
            delay=args.delay,
            overwrite=args.overwrite,
            statsd=statsd,
        )
        print(f"Replay completed successfully. Wrote {lines_written} lines to {dest}.")
    except Exception:
        statsd.increment("errors")
        raise
    finally:
        statsd.close()


if __name__ == "__main__":
    main()
