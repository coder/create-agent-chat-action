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

The action resolves the acting user from the GitHub user who applied the label (used for org pick and the per-user reuse label). The chat itself is owned by the user the `coder-token` belongs to. Set `acting-coder-username` to override the acting user; see [Identity](#identity-resolution) and [Security](#security-model) for the full model.

## Inputs

| Name                   | Required | Default | Description |
| ---------------------- | -------- | ------- | ----------- |
| `coder-url`            | yes      |         | Coder deployment URL. |
| `coder-token`          | yes      |         | Coder session token. |
| `chat-prompt`          | yes      |         | Prompt to send to the agent. |
| `github-url`           | yes      |         | Issue or pull request URL. |
| `github-token`         | yes      |         | Used to post and update comments. |
| `acting-coder-username`       | no       |         | Override the acting Coder user used for org pick and the per-user reuse label. Mutually exclusive with `acting-github-user-id`. Bypasses the [trust gate](#security-model). Does NOT change the chat owner; the chat is always owned by the `coder-token` holder. |
| `acting-github-user-id`       | no       |         | Resolve the acting Coder user from a linked GitHub id. Mutually exclusive with `acting-coder-username`. Does NOT change the chat owner. |
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
| `acting-coder-username`      | Acting Coder username (org pick, reuse label). The chat owner is the `coder-token` holder, which may differ. |
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

The chat itself is always owned by the user the `coder-token` belongs to: `POST /api/experimental/chats` has no owner override, so the API binds ownership to the session. The action separately resolves an **acting user** used for org pick and the per-user reuse label (`coder-agents-chat-action-user`). First source wins:

1. `acting-coder-username` input. Used directly.
2. `acting-github-user-id` input. Looked up by linked GitHub id; deleted Coder users are filtered.
3. `github.context.payload.sender.id`. Available on most webhook events.
4. `github.context.actor`. Resolved to a GitHub id via Octokit.
5. `GET /api/v2/users/me` against the configured `coder-token`. Used when no input or workflow-context signal applies (`schedule` events, `workflow_dispatch` without sender or actor, custom `repository_dispatch` chains).

If the acting user resolves via `acting-coder-username` or `acting-github-user-id` and the result differs from the `coder-token` owner, the action emits a `core.warning` naming both usernames. The chat is still owned by the token holder; the warning surfaces the divergence so the workflow author can confirm the token belongs to the intended user.

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
          acting-coder-username: doc-check-bot
          chat-prompt: |
            Use the doc-check skill to review PR
            ${{ github.event.pull_request.html_url }}.
          github-url: ${{ github.event.pull_request.html_url }}
          github-token: ${{ github.token }}
          wait: complete
```

`pull_request_target` runs against the base repo and has access to secrets even for fork PRs. The service-account identity bypasses the trust gate so fork PRs are reviewed under the bot's organization and reuse scope. The chat itself is owned by the `coder-token` holder regardless.

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
| `user_not_found`  | No Coder user matched the GitHub identity. | Pass `acting-coder-username`, or have the user link their GitHub account in Coder. |
| `user_ambiguous`  | Multiple live Coder users share the GitHub id. | Set `acting-coder-username` to disambiguate. |
| `org_not_found`   | Org missing or the user has no memberships. The comment names which. | Fix or set `coder-organization`. |
| `api_error`       | Any other Coder API error. The comment includes the underlying message; wrapped errors carry the original `CoderAPIError` via `Error.cause` and the workflow log renders the full cause chain. | Common causes: bad token, bad `workspace-id`, deployment unreachable. |
| `timeout`         | `wait: complete` didn't reach terminal in time. | Raise `wait-timeout-seconds`, or split the work. |

Branch on the kind without parsing the message:

```yaml
- if: failure() && steps.chat.outputs.chat-error-kind == 'spend_exceeded'
  run: echo "::warning::Spend limit hit"
```

## Security model

The **chat owner** is fixed by the `coder-token`: `POST /api/experimental/chats` has no owner override, so every chat the action creates is owned by the user the token belongs to. Workflows running fork PRs with `secrets.CODER_TOKEN` available (the `pull_request_target` pattern) execute under the workflow's Coder identity, end of story. The primary mitigation against attacker-controlled prompts under your token is GitHub's own rule that `secrets.*` is unavailable to `pull_request` events from forks. Use `pull_request_target` only when you've gated execution accordingly.

The **acting user** is the Coder identity resolved for org pick and the per-user reuse label (`coder-agents-chat-action-user`). It is NOT the chat owner. The trust gate protects this acting user from pollution by untrusted triggers, layered on top of (not in place of) GitHub's event-permission model. The gate refuses to auto-resolve when:

- The trigger is a fork pull request (`head.repo` null, `head.repo.fork === true`, or `head.repo.full_name !== base.repo.full_name`).
- The trigger is a comment or review whose `comment.author_association` or `review.author_association` is not `OWNER`, `MEMBER`, or `COLLABORATOR`.

Without the gate, an attacker who happens to have a linked Coder identity could open a fork PR or drop a drive-by comment and the action would attribute the chat (org pick, reuse label) to that identity. On refusal, the action does not fall back to `users/me`: a hostile trigger should not silently collapse onto the token owner. Setting `acting-coder-username` or `acting-github-user-id` bypasses the gate; the workflow author has chosen the identity explicitly.

The gate does not read `issue.author_association` or `pull_request.author_association` because those describe the resource opener, not the event sender (a MEMBER labeling a NONE user's issue is fine).

Independent of the gate: if your workflow uses `pull_request_target` to run against fork PRs, gate execution on author trust separately (label gating, manual approval). The trust gate covers the auto-resolved acting user only.

## Limitations

- `waiting` is ambiguous (agent finished vs. agent waiting for input). The action treats it as terminal under `wait: complete`.
- Parallel triggers race on chat reuse: two simultaneous runs can both miss the lookup and both create. The action picks the most recent on the next run and warns.
- Per-chat spend is not surfaced; the API exposes per-user spend only, which is misleading at chat granularity.

## Versioning

Pin to the major tag (`coder/agents-chat-action@v0`) for the v0 series. Breaking changes ship under a new major.
