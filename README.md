# Coder Agents Chat

GitHub Action that starts a [Coder Agents](https://coder.com/docs/ai-coder/agents) chat against a GitHub issue or pull request, optionally waits for it to finish, and posts the result as a comment. Re-running the workflow on the same target continues the existing chat instead of duplicating.

## Requirements

- Coder deployment with Agents enabled (experimental).
- Coder session token with permission to read users in the target organization and to create chats.
- For GitHub-id identity resolution: deployment configured with [GitHub OAuth](https://coder.com/docs/admin/external-auth#configure-a-github-oauth-app) and the Coder user has linked their GitHub account.

## Quickstart

Triage every issue labeled `coder`:

```yaml
name: Coder triage

on:
  issues:
    types: [labeled]

permissions:
  issues: write

jobs:
  triage:
    if: github.event.label.name == 'coder'
    runs-on: ubuntu-latest
    steps:
      - uses: coder/agents-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          chat-prompt: |
            Read ${{ github.event.issue.html_url }} with `gh`, then write a
            short plan for solving it to PLAN.md and wait for feedback.
          github-url: ${{ github.event.issue.html_url }}
          github-token: ${{ github.token }}
```

The chat runs under the Coder user linked to the GitHub user who applied the label. Set `coder-username` for service-account workflows.

## Inputs

| Name                   | Required | Default | Description |
| ---------------------- | -------- | ------- | ----------- |
| `coder-url`            | yes      |         | Coder deployment URL. |
| `coder-token`          | yes      |         | Coder session token. |
| `chat-prompt`          | yes      |         | Prompt to send to the agent. |
| `github-url`           | yes      |         | Issue or pull request URL. |
| `github-token`         | yes      |         | Used to post and update comments. |
| `coder-username`       | no       |         | Run the chat as this Coder user. Mutually exclusive with `github-user-id`. Bypasses the [trust gate](#security-model). |
| `github-user-id`       | no       |         | Resolve to a Coder user by linked GitHub id. Mutually exclusive with `coder-username`. |
| `coder-organization`   | no       |         | Coder organization name. Recommended for multi-org users. |
| `workspace-id`         | no       |         | Pin the chat to an existing workspace. |
| `model-config-id`      | no       |         | Model configuration to use. |
| `existing-chat-id`     | no       |         | Send a follow-up to a known chat. Skips chat-reuse lookup. Mutually exclusive with `force-new-chat`. |
| `comment-on-issue`     | no       | `true`  | Post the result on `github-url`. |
| `wait`                 | no       | `none`  | `complete` polls every 5s until terminal status or `wait-timeout-seconds`. |
| `wait-timeout-seconds` | no       | `600`   | Max wait when `wait: complete`. |
| `idempotency-key`      | no       |         | Optional sharding key. See [Chat reuse](#chat-reuse). |
| `force-new-chat`       | no       | `false` | Skip chat-reuse lookup and always create. Mutually exclusive with `existing-chat-id`. |

## Outputs

| Name                  | Description |
| --------------------- | ----------- |
| `chat-id`             | Chat UUID. |
| `chat-url`            | Link to the chat in Coder. |
| `chat-created`        | `true` if newly created, `false` if a message was sent to an existing chat. |
| `chat-status`         | `waiting`, `pending`, `running`, `paused`, `completed`, `error`. |
| `chat-title`          | Chat title. |
| `coder-username`      | Coder username the chat ran as. |
| `workspace-id`        | Workspace UUID. |
| `pull-request-url`    | PR or branch URL when the chat tracks changes. |
| `pull-request-state`  | `open`, `closed`, `merged`. |
| `pull-request-title`  | PR title. |
| `pull-request-number` | PR number. |
| `diff-additions`      | Lines added. |
| `diff-deletions`      | Lines deleted. |
| `diff-changed-files`  | Files changed. |
| `head-branch`         | Head branch. |
| `base-branch`         | Base branch. |
| `chat-error-kind`     | Machine-readable error kind. See [Troubleshooting](#troubleshooting). |
| `chat-error-message`  | Human-readable error message. |

PR/diff outputs come from the chat's `diff_status` and are only reliable when the chat created the branch.

## How it works

### Identity resolution

The action picks the Coder user to run the chat as. First source wins:

1. `coder-username` input. Used directly.
2. `github-user-id` input. Looked up by linked GitHub id; deleted Coder users are filtered.
3. `github.context.payload.sender.id`. Available on most webhook events.
4. `github.context.actor`. Resolved to a GitHub id via Octokit. Excluded for `schedule` events (the actor is the workflow file editor, not a triggering user).

If nothing resolves, the action fails and names the inputs to set.

### Organization resolution

1. `coder-organization` input. Looked up by name.
2. First org membership of the resolved user. Non-deterministic for multi-org users; the action warns and recommends pinning `coder-organization`.

Either path fails with `chat-error-kind=org_not_found` when the org doesn't exist or the user has no memberships.

### Chat reuse

By default the action reuses the most recent non-archived chat scoped to the same `github-url`, the same Coder user, and (when `GITHUB_WORKFLOW` is set) the same workflow name. Two workflows targeting the same PR keep separate chats. Re-running the same workflow continues one chat.

Opt out per call with `force-new-chat: true`. Shard the scope further with `idempotency-key` to maintain multiple parallel chats on one target/user/workflow (for example, one per matrix dimension). `existing-chat-id` takes priority over both and skips the lookup.

The action writes these labels on every chat it creates:

| Label                                 | Value                       |
| ------------------------------------- | --------------------------- |
| `coder-agents-chat-action`            | `"true"`                    |
| `gh-target`                           | `<owner>/<repo>#<number>`   |
| `coder-agents-chat-action-user`       | `<coder-user-uuid>`         |
| `coder-agents-chat-action-workflow`   | `<GITHUB_WORKFLOW>` (when set) |
| `<sanitized-idempotency-key>`         | `"true"` (when set)         |

The `idempotency-key` input is sanitized to fit the platform's label-key regex (`^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`, 64 bytes): lowercased, characters outside `[a-z0-9._/-]` replaced with `-`, leading non-alphanumerics trimmed, truncated. A value that sanitizes to a reserved label key is rejected at startup.

### Wait mode

`wait: complete` polls `GET /api/experimental/chats/{id}` every 5 seconds until the chat reaches `waiting`, `completed`, or `error`, or `wait-timeout-seconds` elapses. The comment (when enabled) is posted only after the terminal status; mid-poll updates are suppressed.

### Comment lifecycle

The action maintains one comment per `github-url` per workflow using a hidden HTML marker. Re-runs update the comment in place; they don't stack. The marker is:

```
<!-- coder-agents-chat-action:<key> -->
```

`<key>` is the sanitized `idempotency-key` when set, otherwise `<owner>/<repo>#<number>:<workflow-name>` derived from `github-url` and `GITHUB_WORKFLOW`. Two workflows with the same `name:` collide; give them distinct names.

## Recipes

### Doc-check on every PR, under a service account

```yaml
name: Doc check

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  issues: write

jobs:
  doc-check:
    runs-on: ubuntu-latest
    steps:
      - uses: coder/agents-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          coder-organization: ${{ secrets.CODER_ORG }}  # required if the bot belongs to more than one org
          coder-username: doc-check-bot
          chat-prompt: |
            Use the doc-check skill to review PR
            ${{ github.event.pull_request.html_url }}.
          github-url: ${{ github.event.pull_request.html_url }}
          github-token: ${{ github.token }}
          wait: complete
```

`pull_request_target` runs against the base repo and has access to secrets even for fork PRs. The service-account identity bypasses the trust gate so fork PRs are reviewed under a known bot.

### Send a follow-up

```yaml
- uses: coder/agents-chat-action@v0
  with:
    coder-url: ${{ secrets.CODER_URL }}
    coder-token: ${{ secrets.CODER_TOKEN }}
    chat-prompt: "Also add unit tests for the fix."
    github-url: ${{ github.event.pull_request.html_url }}
    github-token: ${{ github.token }}
```

Default chat reuse finds the most recent matching chat and sends the follow-up. No `existing-chat-id` needed when the second invocation runs in the same workflow as the first.

### Force a fresh chat

```yaml
- uses: coder/agents-chat-action@v0
  with:
    # ...
    force-new-chat: true
```

### Gate downstream steps on whether the agent opened a PR

The agent decides whether to fix the issue (opens a PR) or leave a comment. After `wait: complete` returns, `pull-request-url` is set when the chat tracked a PR; downstream steps branch on it.

```yaml
- id: chat
  uses: coder/agents-chat-action@v0
  with:
    coder-url: ${{ secrets.CODER_URL }}
    coder-token: ${{ secrets.CODER_TOKEN }}
    chat-prompt: "Fix the bug described in this issue."
    github-url: ${{ github.event.issue.html_url }}
    github-token: ${{ github.token }}
    wait: complete

- if: steps.chat.outputs.pull-request-url != ''
  run: gh pr edit ${{ steps.chat.outputs.pull-request-url }} --add-label ai-generated
  env:
    GH_TOKEN: ${{ github.token }}
```

## Troubleshooting

The action sets `chat-error-kind` and `chat-error-message` on failure, posts a comment when `comment-on-issue` is `true`, and exits non-zero.

| `chat-error-kind` | What happened | What to do |
| ----------------- | ------------- | ---------- |
| `spend_exceeded`  | Chat spend limit reached. Spent and limit are in the comment. | Wait for reset or raise the deployment's per-user limit. |
| `user_not_found`  | No Coder user matched the GitHub identity. | Pass `coder-username`, or have the user link their GitHub account in Coder. |
| `user_ambiguous`  | Multiple live Coder users share the GitHub id. | Set `coder-username` to disambiguate. |
| `org_not_found`   | Org missing or the user has no memberships. The comment names which. | Fix or set `coder-organization`. |
| `api_error`       | Any other Coder API error. The comment includes the underlying message; wrapped errors carry the original `CoderAPIError` via `Error.cause` and the workflow log renders the full cause chain. | Common causes: bad token, bad `workspace-id`, deployment unreachable. |
| `timeout`         | `wait: complete` didn't reach terminal in time. | Raise `wait-timeout-seconds`, or split the work. |

Branch on the kind without parsing the message:

```yaml
- if: failure() && steps.chat.outputs.chat-error-kind == 'spend_exceeded'
  run: echo "::warning::Spend limit hit"
```

## Security model

Identity auto-resolve binds the Coder user matching the GitHub event sender to the chat. The trust gate refuses to auto-resolve when the trigger is untrusted:

- Fork PRs (`head.repo` null, `head.repo.fork === true`, or `head.repo.full_name !== base.repo.full_name`).
- Comment or review events whose `comment.author_association` or `review.author_association` is not `OWNER`, `MEMBER`, or `COLLABORATOR`.

The gate doesn't read `issue.author_association` or `pull_request.author_association` because those describe the resource opener, not the event sender (a MEMBER labeling a NONE user's issue is fine).

For other events the action defers to GitHub's own event-permission model. Setting `coder-username` or `github-user-id` explicitly bypasses the gate; the workflow author has chosen the identity.

Independent of the gate: fork PRs that need secrets must run under `pull_request_target`, not `pull_request`.

## Limitations

- `waiting` is ambiguous (agent finished vs. agent waiting for input). The action treats it as terminal under `wait: complete`.
- Parallel triggers race on chat reuse: two simultaneous runs can both miss the lookup and both create. The action picks the most recent on the next run and warns.
- Per-chat spend is not surfaced; the API exposes per-user spend only, which is misleading at chat granularity.

## Versioning

Pin to the major tag (`coder/agents-chat-action@v0`) for the v0 series. Breaking changes ship under a new major.
