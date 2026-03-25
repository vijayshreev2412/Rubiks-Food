#!/usr/bin/env python3
"""Replay lines from a source log file into a destination file."""

from __future__ import annotations

import argparse
import time
from pathlib import Path


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
    return parser.parse_args()


def replay_log(source: Path, dest: Path, repeat: int, delay: float, overwrite: bool) -> None:
    if repeat < 1:
        raise ValueError("--repeat must be at least 1")
    if delay < 0:
        raise ValueError("--delay must be >= 0")
    if not source.exists():
        raise FileNotFoundError(f"Source file not found: {source}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    mode = "w" if overwrite else "a"

    with dest.open(mode, encoding="utf-8") as dest_handle:
        for _ in range(repeat):
            with source.open("r", encoding="utf-8") as src_handle:
                for line in src_handle:
                    dest_handle.write(line)
                    dest_handle.flush()
                    time.sleep(delay)


def main() -> None:
    args = parse_args()
    replay_log(
        source=Path(args.source).expanduser(),
        dest=Path(args.dest).expanduser(),
        repeat=args.repeat,
        delay=args.delay,
        overwrite=args.overwrite,
    )


if __name__ == "__main__":
    main()
