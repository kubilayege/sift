#!/bin/sh
# Build release binaries for every platform the site offers, into release/.
#   macOS arm64 + x86_64: native cargo (Xcode SDK covers both).
#   Linux x86_64 + arm64: static musl builds inside Docker (rust:alpine), so they run on any distro.
# Usage: scripts/release.sh            (all)   |   scripts/release.sh mac   |   scripts/release.sh linux
set -e
cd "$(dirname "$0")/.."
OUT=release
mkdir -p "$OUT"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
which=${1:-all}

[ -f web/dist/index.html ] || npm run build

pack() { # <binary> <name>
  tmp=$(mktemp -d)
  cp "$1" "$tmp/sift"
  chmod 755 "$tmp/sift"
  tar -C "$tmp" -czf "$OUT/$2.tar.gz" sift
  rm -r "$tmp"
  echo "packed $OUT/$2.tar.gz"
}

if [ "$which" = all ] || [ "$which" = mac ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    cargo build --release --target "$t"
  done
  pack target/aarch64-apple-darwin/release/sift sift-macos-arm64
  pack target/x86_64-apple-darwin/release/sift sift-macos-x86_64
fi

if [ "$which" = all ] || [ "$which" = linux ]; then
  # Colima and friends do not always share the home directory, so stream the source in over stdin
  # and the binary back out over stdout. Registry and target caches live in named volumes.
  # Both targets build in one native container: arm64 natively, x86_64 cross-compiled with zig
  # (building x86_64 under QEMU emulation crashes the C compiler on oniguruma).
  mkdir -p target/linux
  tar -c --exclude=./target --exclude=./node_modules --exclude=./.git --exclude=./.sift --exclude=./site --exclude=./release -f - . |
    docker run -i --rm \
      -v sift-cargo-registry:/usr/local/cargo/registry -v sift-cargo-bin:/opt/cargo-bin -v sift-target-linux:/target -e CARGO_TARGET_DIR=/target \
      rust:1-alpine sh -c '
        set -e
        apk add --no-cache musl-dev build-base zig >/dev/null
        export PATH=/opt/cargo-bin/bin:$PATH
        command -v cargo-zigbuild >/dev/null || cargo install --root /opt/cargo-bin cargo-zigbuild >&2
        rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl >&2
        mkdir /src && tar -x -C /src && cd /src
        cargo zigbuild --release --target aarch64-unknown-linux-musl >&2
        cargo zigbuild --release --target x86_64-unknown-linux-musl >&2
        tar -c -C /target aarch64-unknown-linux-musl/release/sift x86_64-unknown-linux-musl/release/sift
      ' | tar -x -C target/linux
  pack target/linux/aarch64-unknown-linux-musl/release/sift sift-linux-arm64
  pack target/linux/x86_64-unknown-linux-musl/release/sift sift-linux-x86_64
fi

( cd "$OUT" && shasum -a 256 *.tar.gz > SHA256SUMS )
echo "$VERSION" > "$OUT/VERSION"
ls -la "$OUT"
