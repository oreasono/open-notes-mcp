#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
go_bin=${GO_BIN:-go}

build_one() {
  goos=$1
  goarch=$2
  npm_arch=$3
  executable=notes-mcp
  if [ "$goos" = windows ]; then
    executable=notes-mcp.exe
  fi
  output="$repo_root/npm/$npm_arch/bin/$executable"
  mkdir -p "$(dirname -- "$output")"
  cp "$repo_root/LICENSE" "$repo_root/npm/$npm_arch/LICENSE"
  (
    cd "$repo_root"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" "$go_bin" build \
      -trimpath -ldflags '-s -w -buildid=' -o "$output" ./cmd/notes-mcp
  )
  chmod 0755 "$output"
}

build_one darwin arm64 darwin-arm64
build_one darwin amd64 darwin-x64
build_one linux arm64 linux-arm64
build_one linux amd64 linux-x64
build_one windows arm64 win32-arm64
build_one windows amd64 win32-x64
