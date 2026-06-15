#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s DIRECTORY\n' "${0##*/}" >&2
  exit 2
fi

target_dir=$1

if [[ ! -d "$target_dir" ]]; then
  printf 'Error: directory not found: %s\n' "$target_dir" >&2
  exit 1
fi

codex -C "$target_dir" --sandbox workspace-write --ask-for-approval on-request
