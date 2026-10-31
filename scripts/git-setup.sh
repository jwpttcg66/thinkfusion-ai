#!/bin/sh
# Apply the repo's local git conventions. Idempotent — safe to re-run,
# and required once after every fresh clone.
#
#   ./scripts/git-setup.sh
set -e

cd "$(dirname "$0")/.."

echo "Configuring git for: $(pwd)"

# --- hooks & templates -------------------------------------------------
chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks
git config commit.template .gitmessage

# --- sane defaults -----------------------------------------------------
git config core.autocrlf false
git config core.whitespace trailing-space,space-before-tab
git config init.defaultBranch main
git config pull.rebase false
git config push.default current
git config merge.conflictStyle zdiff3
git config rerere.enabled true
git config tag.sort version:refname
git config color.ui auto

# --- aliases -----------------------------------------------------------
git config alias.st "status -sb"
git config alias.lg "log --graph --abbrev-commit --decorate --format=format:'%C(bold blue)%h%C(reset) - %C(bold green)(%ar)%C(reset) %C(white)%s%C(reset) %C(dim white)- %an%C(reset)%C(auto)%d%C(reset)' --all"
git config alias.co checkout
git config alias.br "branch -vv"
git config alias.unstage "reset HEAD --"
git config alias.last "log -1 HEAD --stat"
git config alias.amend "commit --amend --no-edit"
git config alias.pushf "push --force-with-lease"
git config alias.gone "!git fetch -p && git branch -vv | grep ': gone]' | awk '{print \$1}' | xargs -n 1 git branch -d 2>/dev/null || true"

echo ""
echo "Done. Active settings:"
printf "  hooksPath      %s\n" "$(git config core.hooksPath)"
printf "  commit.template %s\n" "$(git config commit.template)"
printf "  protectMain    %s\n" "$(git config --get hooks.protectMain || echo 'false (off)')"
echo ""
echo "Hooks now enforced: commit-msg (Conventional Commits), pre-commit (conflicts/large files/secrets), pre-push (main branch, opt-in)."
