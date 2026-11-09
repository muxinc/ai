# Releasing `@mux/ai`

Releases are automated with [release-please](https://github.com/googleapis/release-please)
and run from [`.github/workflows/publish.yml`](../.github/workflows/publish.yml).

## How it works

1. Every merge to `main` runs release-please. It reads the conventional commit
   titles merged since the last release and keeps one **release PR** open
   (titled `chore: release <version>`). The PR bumps `package.json`,
   `package-lock.json` and the release-please manifest, and adds the release's
   entry to `CHANGELOG.md`. Each new merge to `main` updates it.
2. **Merging the release PR is the release.** The same workflow run tags
   `v<version>`, creates the GitHub release with the changelog entry as its
   notes, publishes to npm through trusted publishing (OIDC, no token), and
   posts to Slack.

Merges that contain only `docs`, `chore`, `refactor`, `test`, `build`, `ci` or
`style` commits don't open a release PR on their own. See
[CONTRIBUTING.md](../CONTRIBUTING.md#commit-messages-and-pr-titles) for how
each type affects the version.

## Cutting a release

1. Open the release PR and read the changelog entry. It is what consumers
   will see, so fix anything misleading there (see below).
2. Wait for CI to pass, get an approval, and merge.
3. Watch the **Release** workflow run on `main`. When it finishes, the version
   is on npm and Slack has been notified.

## Adjusting a release

- **Fix a changelog entry or a version bump that came from a bad PR title.**
  Edit the merged PR's description to add an override. release-please uses it
  in place of the commit message the next time it runs (on the next merge to
  `main`, or dispatch the Release workflow with no input):

  ```text
  BEGIN_COMMIT_OVERRIDE
  fix(transcripts): accept MM:SS.mmm VTT timestamps
  END_COMMIT_OVERRIDE
  ```

- **Force a specific version.** Merge a commit (an empty one is fine) whose
  body has a footer such as `Release-As: 1.0.0`.
- **Prerelease.** Use a prerelease version with `Release-As`, such as
  `Release-As: 1.0.0-beta.1`. Versions containing a `-` publish to the `next`
  dist-tag instead of `latest`.

## Recovering a failed publish

If the run tagged the release but failed before or during `npm publish`, fix
the cause and then finish the release from `main`:

```sh
gh workflow run publish.yml --ref main -f recover_version=<version>
```

Recovery checks out the release tag, skips the publish if that version already
reached npm, and then sends the Slack announcement. It only accepts the current
version on `main`, so it can't move the `latest` dist-tag backwards. If `main`
has moved on to a newer release, ship the fix in the next release instead.

## Preview builds

Every PR from a branch in this repo, and every push to `main`, publishes an
installable preview to [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new).
A bot comment on the PR has the install command, for example:

```sh
npm i https://pkg.pr.new/@mux/ai@<pr-number-or-commit-sha>
```

Use it to try a change in a consuming app before it's released. Previews are
versioned `0.0.0-preview-<sha>`, so they never satisfy a semver range meant for
a real release. PRs from forks don't get previews.

## One-time setup

These live outside the repository and are needed for the full flow:

| What | Where | If it's missing |
| --- | --- | --- |
| npm trusted publisher for `muxinc/ai`, workflow `publish.yml` | npmjs.com package settings | Publish fails with a 404 from the token exchange |
| GitHub App for release-please: `RELEASE_APP_CLIENT_ID` (variable) and `RELEASE_APP_PRIVATE_KEY` (secret); the app needs contents and pull-request write access | Repository settings → Secrets and variables → Actions | Release PRs are opened with `GITHUB_TOKEN`, which starts no CI; close and reopen the release PR to run its checks |
| `SLACK_RELEASE_WEBHOOK_URL` secret (a Slack incoming webhook) | Repository settings → Secrets and variables → Actions | The announcement is skipped with a notice |
| pkg.pr.new GitHub App | [github.com/apps/pkg-pr-new](https://github.com/apps/pkg-pr-new) | The preview job fails |
| Squash merge commit title set to "Pull request title" | Repository settings → General → Pull Requests | Single-commit PRs land with their commit message instead of the checked PR title |
| `Pull Request Title Check` as a required status check | The `main` ruleset | Non-conventional titles can merge and drop out of the changelog |
| `production` environment | Created by the first release run; add protection rules there if wanted | n/a |
