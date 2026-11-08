#!/bin/sh
set -eu

# Build from the fetched main commit in a disposable worktree.
repo=$(git rev-parse --show-toplevel)
git fetch origin refs/heads/main:refs/remotes/origin/main
commit=$(git rev-parse origin/main)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/mandala-build.XXXXXX")
worktree="$tmp/source"
cleanup() {
  git -C "$repo" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM
git worktree add --detach "$worktree" "$commit"
cd "$worktree"
npm ci
npm ci --prefix desktop
version=$(node -p "require('./package.json').version + '-local.main.' + process.argv[1].slice(0, 7)" "$commit")
MANDALA_VERSION="$version" npm run desktop:build
arch=$(node -p 'process.arch')
case "$arch" in arm64) app=release/desktop/mac-arm64/Mandala.app ;; x64) app=release/desktop/mac/Mandala.app ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
dmg="release/desktop/Mandala-$version-mac-$arch.dmg"
node -e "const b=require('./'+process.argv[1]+'/Contents/Resources/runtime/build.json'); if(b.commit!==process.argv[2] || b.sourceDirty) process.exit(1)" "$app" "$commit"
codesign --verify --deep --strict "$app"
hdiutil verify "$dmg"
common=$(git rev-parse --git-common-dir)
output="$(dirname "$common")/.development/dmg"
mkdir -p "$output"
cp "$dmg" "$output/"
echo "DMG: $output/$(basename "$dmg")"

# Never interrupt an active App or its background runtime.
installed=/Applications/Mandala.app
[ -d "$installed" ] || { echo "Existing $installed not found; use the DMG to install." >&2; exit 1; }
if ps -axo command= | awk 'index($0,"/Applications/Mandala.app/Contents/MacOS/Mandala") || index($0,"/Applications/Mandala.app/Contents/Resources/runtime/server/main.mjs") { found=1 } END { exit !found }'; then
  echo 'In Mandala choose Stop runtime and quit… before updating, then run this script again.' >&2
  exit 1
fi
git fetch origin refs/heads/main:refs/remotes/origin/main
[ "$(git rev-parse origin/main)" = "$commit" ] || { echo 'main changed during the build; run again.' >&2; exit 1; }
backup="${HOME}/.mandala-backups/Mandala-$(date +%Y%m%d-%H%M%S)-$$.app"
mkdir -p "$(dirname "$backup")"
ditto "$installed" "$backup"
stage="/Applications/.Mandala-update-$$.app"
ditto "$app" "$stage"
codesign --verify --deep --strict "$stage"
previous="/Applications/.Mandala-previous-$$.app"
mv "$installed" "$previous"
if ! mv "$stage" "$installed"; then
  mv "$previous" "$installed"
  exit 1
fi
rm -rf "$previous"
echo "Updated Mandala to $version ($commit). Previous App: $backup"
open "$installed"
