# Releasing `@mux/ai`

This is the process a maintainer follows to cut a new release. Contributors
opening a PR don't need this — releases are cut by maintainers after a PR is
merged, not as part of the PR itself.

## Before you start

Confirm `main` doesn't already have a pending version bump: the version
published on npm should match the `version` field in `package.json`. If they
already match, someone's already bumped since the last release and you just
need to cut the GitHub release (skip to step 5).

## Steps

1. **Branch off latest `main`.**
2. **Bump the version:**

   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   ```

   This updates `package.json` and `package-lock.json` together in one step.
   `--no-git-tag-version` skips npm's built-in auto-commit/auto-tag — this
   repo tags at release time (step 6), not at bump time.
3. **Commit and push.** A single `chore: bump version` commit is enough —
   see recent history for precedent.
4. **Open a PR, wait for CI, merge to `main`.**
5. **Wait for CI to pass on `main` again post-merge** — the merge commit is
   what actually gets released.
6. **Cut the GitHub release:**
   - GitHub → Releases → "Draft a new release"
   - Create a new tag matching the version (e.g. `v0.38.0`)
   - Set the release title to the same version string
   - Click "Generate release notes"
   - Confirm **"Set as the latest release"** is checked
   - Publish
7. **Wait for the publish-to-npm CI job** the release triggers, then confirm
   the new version is live on npm.
8. **Post a heads-up in Slack.** No automation for this yet — do it by hand.

There's also a short screen-recorded walkthrough of this process:
https://stream.new/v/7sEl01t01a3FBtNDchzq7qrVXQ95H029hblL11Sl01i4BKc
