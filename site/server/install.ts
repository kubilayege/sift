import { RELEASES, VERSION } from "../shared/releases";

/** The `curl … | sh` installer. Checksums are baked in, so a tampered download fails loudly. */
export function installScript(base: string): string {
  const sums = RELEASES.map((r) => `    ${r.name}) sum=${r.sha256} ;;`).join("\n");
  return `#!/bin/sh
# sift ${VERSION} installer: ${base}
#   curl -fsSL ${base}/install.sh | sh
# Environment:
#   SIFT_BIN_DIR=/path   where the binary goes (default ~/.local/bin)
#   SIFT_NO_SKILL=1      skip installing the Claude Code skill
set -eu

BASE="${base}"
BIN_DIR="\${SIFT_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\\n' "$*"; }
die() { printf 'sift install: %s\\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) die "no prebuilt binary for $(uname -s). On Windows, run this inside WSL." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x86_64 ;;
  *) die "no prebuilt binary for $(uname -m)." ;;
esac
name="sift-$os-$arch"

case "$name" in
${sums}
    *) die "no prebuilt binary for $os/$arch." ;;
esac

command -v curl >/dev/null 2>&1 || die "needs curl."
command -v git >/dev/null 2>&1 || say "Note: sift needs git at runtime, and git was not found on PATH."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading sift ${VERSION} for $os/$arch..."
curl -fsSL "$BASE/download/$name.tar.gz" -o "$tmp/sift.tar.gz" || die "download failed."

if command -v shasum >/dev/null 2>&1; then
  got=$(shasum -a 256 "$tmp/sift.tar.gz" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/sift.tar.gz" | cut -d' ' -f1)
else
  got=$sum
  say "Note: no shasum or sha256sum found, skipping the checksum check."
fi
[ "$got" = "$sum" ] || die "checksum mismatch (expected $sum, got $got)."

tar -xzf "$tmp/sift.tar.gz" -C "$tmp"
mkdir -p "$BIN_DIR"
# Replace rather than overwrite, so a running sift server keeps its binary.
rm -f "$BIN_DIR/sift"
mv "$tmp/sift" "$BIN_DIR/sift"
chmod 755 "$BIN_DIR/sift"
say "Installed $BIN_DIR/sift ($("$BIN_DIR/sift" --version))"

if [ -z "\${SIFT_NO_SKILL:-}" ] && [ -d "$HOME/.claude" ]; then
  "$BIN_DIR/sift" skill install || say "Could not install the Claude Code skill; run: sift skill install"
else
  say "Agent skill: run 'sift skill install' for Claude Code, or 'sift skill print' for other agents."
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "" ; say "Add $BIN_DIR to your PATH, e.g.:" ; say "  echo 'export PATH=\\"$BIN_DIR:\\$PATH\\"' >> ~/.zshrc" ;;
esac
say ""
say "Done. Run 'sift' inside any git repository to open the review."
`;
}
