#!/bin/sh
# Build sift (web UI + Rust binary) and install it.
#   ./install.sh              -> ~/.local/bin/sift and the agent skill in ~/.claude/skills
#   PREFIX=/usr/local ./install.sh
set -e
cd "$(dirname "$0")"
PREFIX="${PREFIX:-$HOME/.local}"

command -v cargo >/dev/null || { echo "install.sh: needs Rust (https://rustup.rs)"; exit 1; }
command -v npm >/dev/null || { echo "install.sh: needs Node.js/npm to build the UI"; exit 1; }

[ -d node_modules ] || npm install --no-audit --no-fund
npm run build
cargo build --release

mkdir -p "$PREFIX/bin"
# Replace (not overwrite in place) so a running server keeps its binary.
rm -f "$PREFIX/bin/sift"
cp target/release/sift "$PREFIX/bin/sift"
echo "Installed $PREFIX/bin/sift ($("$PREFIX/bin/sift" --version))"

skill="$HOME/.claude/skills/sift"
if [ -L "$skill" ]; then
  echo "Skill: $skill is a link to $(readlink "$skill"), leaving it."
else
  "$PREFIX/bin/sift" skill install
fi
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "Note: add $PREFIX/bin to your PATH." ;;
esac
