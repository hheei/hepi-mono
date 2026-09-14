#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d "${TMPDIR:-/tmp}/hepi-test.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/home/.config" "$root/tmp" "$root/cache/pnpm"

env -i \
	PATH="$PATH" \
	HOME="$root/home" \
	TMPDIR="$root/tmp" \
	XDG_CONFIG_HOME="$root/home/.config" \
	XDG_CACHE_HOME="$root/cache" \
	PNPM_HOME="$root/cache/pnpm" \
	GIT_CONFIG_NOSYSTEM=1 \
	GIT_CONFIG_GLOBAL=/dev/null \
	GIT_TERMINAL_PROMPT=0 \
	TZ=UTC \
	PI_OFFLINE=1 \
	pnpm test
