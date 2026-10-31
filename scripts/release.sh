#!/bin/sh
# Cut a release: bump VERSION, prepend a CHANGELOG entry built from
# Conventional Commits, commit, and create an annotated tag.
#
#   ./scripts/release.sh patch            # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor            # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major            # 0.1.0 -> 1.0.0
#   ./scripts/release.sh patch --dry-run  # preview only
set -e

cd "$(dirname "$0")/.."

bump="${1:-}"
dry_run=false
[ "${2:-}" = "--dry-run" ] && dry_run=true

case "$bump" in
	patch | minor | major) ;;
	*)
		echo "Usage: $0 <patch|minor|major> [--dry-run]" >&2
		exit 1
		;;
esac

if [ -n "$(git status --porcelain)" ]; then
	echo "ERROR: working tree is dirty. Commit or stash first." >&2
	exit 1
fi

current=$(tr -d '[:space:]' <VERSION 2>/dev/null || echo "0.0.0")
current=${current:-0.0.0}
major=$(printf '%s' "$current" | cut -d. -f1)
minor=$(printf '%s' "$current" | cut -d. -f2)
patch=$(printf '%s' "$current" | cut -d. -f3)

case "$bump" in
	patch) patch=$((patch + 1)) ;;
	minor) minor=$((minor + 1)); patch=0 ;;
	major) major=$((major + 1)); minor=0; patch=0 ;;
esac
next="$major.$minor.$patch"

last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$last_tag" ]; then
	range="$last_tag..HEAD"
else
	range="HEAD"
fi

commits=$(git log "$range" --no-merges --pretty=format:"- %s (%h)" \
	| grep -E '^- (feat|fix|perf|refactor)' || true)
[ -n "$commits" ] || commits="- 维护性更新（无面向用户的功能变更）"

today=$(date +%Y-%m-%d)
entry="## v$next - $today

$commits"

if [ "$dry_run" = "true" ]; then
	echo "--- dry run ---"
	echo "current: v$current"
	echo "next:    v$next"
	echo ""
	printf '%s\n' "$entry"
	exit 0
fi

# Prepend the entry above the newest existing version heading
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

if [ ! -s CHANGELOG.md ]; then
	# No changelog yet — create one with a title
	{
		printf '# Changelog\n\n'
		printf '%s\n' "$entry"
	} >CHANGELOG.md
elif grep -q '^## v' CHANGELOG.md; then
	# Insert above the newest existing version heading, keeping the intro on top
	first_line=$(grep -n '^## v' CHANGELOG.md | head -n 1 | cut -d: -f1)
	sed -n "1,$((first_line - 1))p" CHANGELOG.md >"$tmp_dir/head"
	sed -n "${first_line},\$p" CHANGELOG.md >"$tmp_dir/body"
	{
		cat "$tmp_dir/head"
		printf '%s\n\n' "$entry"
		cat "$tmp_dir/body"
	} >"$tmp_dir/new"
	mv "$tmp_dir/new" CHANGELOG.md
else
	# Intro exists but no releases yet — append the first entry below it
	{
		cat CHANGELOG.md
		printf '\n%s\n' "$entry"
	} >"$tmp_dir/new"
	mv "$tmp_dir/new" CHANGELOG.md
fi

printf '%s\n' "$next" >VERSION

git add VERSION CHANGELOG.md
git commit -m "chore(release): v$next"
git tag -a "v$next" -m "v$next"

echo ""
echo "Released v$next (was v$current)."
echo "Push it with:  git push && git push --tags"
