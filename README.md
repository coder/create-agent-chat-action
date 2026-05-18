# Coder Agents Chat

GitHub Action that starts a [Coder Agents](https://coder.com/docs/ai-coder/agents) chat against a GitHub issue or pull request, optionally waits for it to finish, and posts the result as a comment. Re-running the workflow on the same target continues the existing chat instead of duplicating.

The chat owner is always the user the `coder-token` belongs to. Read [Security model](#security-model) before adopting on a public repo.

## Requirements

- Coder deployment with Agents enabled (experimental).
- Coder session token belonging to the user the chats should run as. Treat this token as a high-value secret: anyone holding it acts as that Coder user via the agent's tool plane (see [Security model](#security-model)).

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

The chat runs as whoever the `coder-token` belongs to; that identity is the only one the chats API supports. Workflows that target events that route to this action without `secrets.CODER_TOKEN` redaction (`issue_comment`, `pull_request_target`, etc.) must add their own `if:` gate; see [Security model](#security-model).

## Inputs

| Name                   | Required | Default | Description |
| ---------------------- | -------- | ------- | ----------- |
| `coder-url`            | yes      |         | Coder deployment URL. |
| `coder-token`          | yes      |         | Coder session token. The user this token belongs to is the chat owner; the chats API has no owner override. |
| `chat-prompt`          | yes      |         | Prompt to send to the agent. |
| `github-url`           | yes      |         | Issue or pull request URL. Host is validated; only `https://github.com/<owner>/<repo>/issues/<n>` and `https://github.com/<owner>/<repo>/pull/<n>` are accepted. |
| `github-token`         | yes      |         | Used to post and update comments. |
| `coder-organization`   | no       |         | Coder organization name. Recommended for multi-org token owners. |
| `workspace-id`         | no       |         | Pin the chat to an existing workspace. |
| `model-config-id`      | no       |         | Model configuration to use. |
| `existing-chat-id`     | no       |         | Send a follow-up to a known chat. Skips chat-reuse lookup. Mutually exclusive with `force-new-chat`. |
| `comment-on-issue`     | no       | `true`  | Post the result on `github-url`. |
| `wait`                 | no       | `none`  | `complete` polls every 5s until terminal status or `wait-timeout-seconds`. |
| `wait-timeout-seconds` | no       | `600`   | Max wait when `wait: complete`. |
| `idempotency-key`      | no       |         | Optional sharding key on the reuse scope. See [Chat reuse](#chat-reuse). |
| `force-new-chat`       | no       | `false` | Skip chat-reuse lookup and always create. Mutually exclusive with `existing-chat-id`. |

## Outputs

| Name                  | Description |
| --------------------- | ----------- |
| `chat-id`             | Chat UUID. |
| `chat-url`            | Link to the chat in Coder. |
| `chat-created`        | `true` if newly created, `false` if a message was sent to an existing chat. |
| `chat-status`         | `waiting`, `pending`, `running`, `paused`, `completed`, `error`. |
| `chat-title`          | Chat title. |
| `coder-username`      | Coder username the `coder-token` belongs to (always the chat owner). |
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

There is one Coder identity in play. `POST /api/experimental/chats` binds the chat owner to the user the session token belongs to; the API has no owner override. The action calls `GET /api/v2/users/me` once to read the token owner's username and organization memberships, then creates the chat. The `coder-username` output is the token owner.

### Organization resolution

1. `coder-organization` input. Looked up by name.
2. First org membership of the token owner. Non-deterministic for multi-org users; the action warns and recommends pinning `coder-organization`.

Either path fails with `chat-error-kind=org_not_found` when the org doesn't exist or the user has no memberships.

### Chat reuse

By default the action reuses the most recent non-archived chat scoped to the same `github-url` and (when `GITHUB_WORKFLOW` is set) the same workflow name. Two workflows targeting the same PR keep separate chats. Re-running the same workflow continues one chat.

All chats this action creates are owned by the `coder-token` holder, so the reuse scope deliberately omits a per-actor label. Workflows that want per-actor separation pass it through `idempotency-key` themselves, for example `idempotency-key: ${{ github.actor }}`.

Opt out per call with `force-new-chat: true`. Shard the scope further with `idempotency-key` to maintain multiple parallel chats on one target/workflow (for example, one per matrix dimension). `existing-chat-id` takes priority over both and skips the lookup.

The action writes these labels on every chat it creates:

| Label                                  | Value                          |
| -------------------------------------- | ------------------------------ |
| `coder-agents-chat-action`             | `"true"`                       |
| `gh-target`                            | `<owner>/<repo>#<number>`      |
| `coder-agents-chat-action-workflow`    | `<GITHUB_WORKFLOW>` (when set) |
| `coder-agents-chat-action-idempotency` | `<sanitized idempotency-key>` (when set) |

The `idempotency-key` input is sanitized to fit the platform's label-value regex (`^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`, 64 bytes): lowercased, characters outside `[a-z0-9._/-]` replaced with `-`, leading non-alphanumerics trimmed, truncated. The sanitizer is lossy: `MyKey!` and `MyKey?` both collapse to `mykey-`. Pass values you control (commit SHAs, label slugs, `github.actor`) rather than free-form titles.

### Wait mode

`wait: complete` polls `GET /api/experimental/chats/{id}` every 5 seconds until the chat reaches `waiting`, `completed`, or `error`, or `wait-timeout-seconds` elapses. The comment (when enabled) is posted only after the terminal status; mid-poll updates are suppressed.

### Comment lifecycle

The action maintains one comment per `github-url` per workflow using a hidden HTML marker. Re-runs update the comment in place; they don't stack. The marker is:

```
<!-- coder-agents-chat-action:<key> -->
```

`<key>` is the sanitized `idempotency-key` when set, otherwise `<owner>/<repo>#<number>:<workflow-name>` derived from `github-url` and `GITHUB_WORKFLOW`. Two workflows with the same `name:` collide; give them distinct names.

## Recipes

### Doc-check on every PR (gated against fork PRs)

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
    # Internal PRs only. `pull_request_target` exposes `secrets.*` to fork
    # PRs by design, so the workflow must filter trust before invoking
    # this action. Swap to a label-allowlist `if:` (for example,
    # `contains(github.event.pull_request.labels.*.name, 'safe-to-review')`)
    # if you want to gate via maintainer-applied labels instead.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: coder/agents-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          coder-organization: ${{ secrets.CODER_ORG }}  # required if the bot belongs to more than one org
          chat-prompt: |
            Use the doc-check skill to review PR
            ${{ github.event.pull_request.html_url }}.
          github-url: ${{ github.event.pull_request.html_url }}
          github-token: ${{ github.token }}
          wait: complete
```

`pull_request_target` runs against the base repo and has access to secrets even for fork PRs. The action's trust gate refuses fork PRs anyway, but the workflow-level `if:` is the right place to make the trust decision because it short-circuits before the runner starts the step. The chat is owned by the `coder-token` holder; the prompt is benign, but the agent will read PR content with its tools (see [Security model](#security-model)).

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
| `org_not_found`   | Org missing or the token owner has no memberships. The comment names which. | Fix or set `coder-organization`. |
| `api_error`       | Any other Coder API error, including trust-gate refusal and `github-url` host validation. The comment includes the underlying message in a code block; wrapped errors carry the original `CoderAPIError` via `Error.cause`, and the workflow log renders the full cause chain. | Common causes: bad token, bad `workspace-id`, deployment unreachable, fork PR refused by the trust gate, non-github.com `github-url`. |
| `timeout`         | `wait: complete` didn't reach terminal in time. | Raise `wait-timeout-seconds`, or split the work. |

Branch on the kind without parsing the message:

```yaml
- if: failure() && steps.chat.outputs.chat-error-kind == 'spend_exceeded'
  run: echo "::warning::Spend limit hit"
```

## Security model

### The chat owner is the `coder-token` holder

`POST /api/experimental/chats` binds the chat owner to whoever the session token authenticates as. There is no owner override. Anyone who can read `secrets.CODER_TOKEN` acts as that Coder user end-to-end, including the agent's tool plane (shell, `gh`, `git push`, `coder external-auth`, MCP servers). Treat the token as a high-value secret. If your platform exposes per-user spend caps, template allowlists, tool allowlists, or scoped external_auth grants, use them on the token owner; this action cannot constrain what the agent can do once a chat exists.

### Trust gate is fail-closed; no input bypass

Before every chat creation, the action calls `classifyTriggerTrust` on the GitHub event payload and refuses untrusted triggers:

- Fork pull requests (`head.repo` null, `head.repo.fork === true`, or `head.repo.full_name !== base.repo.full_name`).
- Comment or review events whose `comment.author_association` or `review.author_association` is not `OWNER`, `MEMBER`, or `COLLABORATOR`.

There is no input bypass: dropping the previous `acting-*` overrides was deliberate. Workflows that target events where `secrets.CODER_TOKEN` is available alongside broad trigger access (`issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_target`) must add their own `if:` gate before the step. Examples:

- `if: github.event.pull_request.head.repo.full_name == github.repository` (internal PRs only).
- `if: contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)` (trusted commenters only).
- `if: contains(github.event.pull_request.labels.*.name, 'safe-to-review')` (label allowlist on a maintainer-applied label).

The gate does not read `issue.author_association` or `pull_request.author_association` because those describe the resource opener, not the event sender (a `MEMBER` labeling a `NONE` user's issue is fine).

### Indirect prompt injection (F1)

The agent reads attacker-authored content during its run: PR titles, PR bodies, issue comments, diffs, and anything else the prompt tells it to fetch (`gh pr view`, `gh issue view --comments`, `gh pr diff`). The agent is a language model; it will follow embedded instructions in that content if they look plausible. Treat any public-repo trigger as adversarial regardless of the trust gate's verdict, because the gate decides whether to create the chat but does not constrain what the chat reads once it runs.

The action ships no defense against this class. Mitigations live deployment-side:

- Pin a hardened workspace template via `workspace-id` (minimal tools, no shell, scoped network egress).
- Use Coder's platform controls to allowlist templates, restrict tool registrations, and scope the token owner's `external_auth` grants. See [Coder Agents platform controls](https://coder.com/docs/ai-coder/agents/platform-controls).
- Keep `coder-token` on a dedicated, minimally-privileged Coder user. The chat's blast radius is whatever that user can reach inside Coder (workspaces, external auth grants, mounted secrets).

The single-most-impactful mitigation against attacker-controlled prompts on a public repo is GitHub's own rule that `secrets.*` is not available to `pull_request` events from forks; the trust gate is a second checkpoint on top of that, not a replacement.

## Limitations

- `waiting` is ambiguous (agent finished vs. agent waiting for input). The action treats it as terminal under `wait: complete`.
- Parallel triggers race on chat reuse: two simultaneous runs can both miss the lookup and both create. The action picks the most recent on the next run and warns.
- Per-chat spend is not surfaced; the API exposes per-user spend only, which is misleading at chat granularity.

## Versioning

Pin to the major tag (`coder/agents-chat-action@v0`) for the v0 series. Breaking changes ship under a new major.
