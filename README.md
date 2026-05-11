# Coder Agent Chat GitHub Action

This GitHub action creates a [Coder Agent Chat](https://coder.com/docs/ai-coder) and optionally posts a comment on a GitHub issue or pull request. It's designed to be used as part of a wider workflow.

## Overview

- Pass a `chat-prompt` and a `github-url` (issue or PR) and the action creates a Coder Agent Chat associated with that GitHub item.
- The action resolves the Coder user to run as. By default it auto-resolves the user from the workflow context (sender of the triggering event, or the `actor` of the run when the payload lacks a usable `sender.id`). Override the resolution with `github-user-id` or `coder-username` when the event-triggering identity is not the one the chat should run as.
  - GitHub-id lookup requires the Coder deployment to be configured with [GitHub OAuth](https://coder.com/docs/admin/external-auth#configure-a-github-oauth-app) and for the Coder user to have linked their GitHub account.
  - Deleted Coder users are automatically excluded from the GitHub-id lookup, so a previously deleted account no longer causes an ambiguous-match error (closes [coder/create-task-action#8](https://github.com/coder/create-task-action/issues/8) for this action; the bug stays open in `create-task-action`).
- Unlike Tasks, **Agents does not require specifying a template**. Agents auto-provisions a workspace, or you can pass an existing `workspace-id`.
- After creation, the action posts a comment on the linked issue or pull request with the chat URL. Disable with `comment-on-issue: false`.
- Send a follow-up message to an existing chat by providing `existing-chat-id`.

## Identity resolution

The action picks the Coder user to run the chat under in this order, taking the first source that yields a value:

1. **`coder-username` input.** Used directly. No GitHub lookup is performed. This is the right choice for service accounts and bot users that do not have a linked GitHub identity.
2. **`github-user-id` input.** Looked up against `/api/v2/users?q=github_com_user_id:<id>` to find the Coder user with that linked GitHub account.
3. **`github.context.payload.sender.id`.** Available on issue, pull request, comment, and most webhook-driven events. Looked up by id, same as `github-user-id`.
4. **`github.context.actor`.** Used as a fallback for events whose payload does not deliver a usable `sender.id` (partial sender objects, certain bot dispatches, custom dispatch chains). The action calls `GET /users/{username}` via Octokit to resolve the actor's numeric GitHub user id, then looks up the Coder user by id. `schedule` events are excluded from auto-resolve entirely (the exclusion fires before source 3) because their `actor` is the workflow file's last editor, not the triggering user; the action fails with a clear error pointing at `coder-username` and `github-user-id` instead.

If none of the above resolve, the action fails with an error message naming `coder-username` and `github-user-id` so the workflow author knows which inputs to set. When source 3 or 4 finds a value but the subsequent Coder or GitHub API call fails, the error names the auto-resolved source (sender id or actor login), preserves the upstream error, and recommends `coder-username` as the bypass.

`coder-username` and `github-user-id` are mutually exclusive; the action rejects setting both.

### Auto-resolve trust gate

Before sources 3 and 4 run, the action applies a trust gate to the triggering identity. The gate refuses auto-resolve, and the action fails with an error naming the offending signal and pointing at `coder-username` / `github-user-id` as the bypass, when:

- The event is a `pull_request` whose head repository is a fork. The check is conservative: a `null` `head.repo` (deleted fork), `pull_request.head.repo.fork === true`, and `pull_request.head.repo.full_name !== pull_request.base.repo.full_name` all count.
- The payload carries `comment.author_association` or `review.author_association` (in that priority) and the value is not one of `OWNER`, `MEMBER`, or `COLLABORATOR`. `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `MANNEQUIN`, and `NONE` are all refused.

The gate deliberately does not read `issue.author_association` or `pull_request.author_association`. Those fields describe the resource *opener*, not the event *sender*. On `issues: [labeled]`, for example, the sender is the labeler, but `issue.author_association` is the issue opener's association. Reading it would refuse a MEMBER labeling a NONE user's issue. The gate covers comment and review events (where the association field reliably describes the sender) and the fork PR case explicitly; for all other events it returns no-signal.

When the gate returns no-signal (no fork, no `comment`/`review` association data), the action defers to GitHub's underlying event-permission model (secret access, branch protection, repository write permission for `workflow_dispatch`, repo-write requirement for `issues` actions like `labeled`/`assigned`). Setting `coder-username` or `github-user-id` bypasses the gate entirely: the workflow author has explicitly chosen which identity the chat runs as.

#### Threat model

Without the gate, a workflow that runs on `pull_request` or `issue_comment` and lets the action auto-resolve identity would bind whichever Coder user matches `sender.id` to the chat run. An attacker who happens to have a Coder identity could then open a PR from a fork, or drop a comment on an issue, to execute attacker-controlled prompts under the workflow's Coder session token. The gate refuses these triggers by default; workflow authors who want to accept the risk (for example, to triage drive-by issues) opt in by setting `coder-username` or `github-user-id` to a known service-account identity.

A related GitHub-side mitigation applies independently: workflows that need to act on fork PRs typically run under `pull_request_target` (which executes against the base repository's code and has access to secrets) and gate execution on a separate check, rather than `pull_request` (which executes against the PR head and does not receive secrets from forks by default). The trust gate is layered on top of that model, not in place of it.

### Service-account mode (single identity for all events)

Setting `coder-username` (or `github-user-id`) bypasses auto-resolve and the trust gate, so every event runs under that one identity. Use this for workflows like a doc-check bot that reviews every PR (including fork PRs from community contributors) under a single Coder service account; the trust gate is intentionally not needed because the workflow author has chosen the identity.

```yaml
name: Doc check

on:
  pull_request:

jobs:
  doc-check:
    runs-on: ubuntu-latest
    steps:
      - name: Coder Create Agent Chat
        uses: coder/create-agent-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          coder-username: "doc-check-bot"
          chat-prompt: "Review the docs touched by ${{ github.event.pull_request.html_url }}."
          github-url: ${{ github.event.pull_request.html_url }}
          github-token: ${{ github.token }}
```

This does not change GitHub's own restrictions on fork PRs: `secrets.*` is unavailable to `pull_request` runs from forks by default. If the workflow needs the Coder token on fork PRs, the workflow author must use `pull_request_target` (or another mechanism) to grant secret access; that decision is outside the action's scope.

## Requirements

- A running Coder deployment with Agents enabled (experimental).
- A Coder session token with the required permissions to:
  - Read all users in the given organization.
  - Create chats.

## Example Usage

The example below starts a Coder Agent Chat when the `coder` label is applied to an issue.

```yaml
name: Start Coder Agent Chat

on:
  issues:
    types:
      - labeled

permissions:
  issues: write

jobs:
  coder-create-chat:
    runs-on: ubuntu-latest
    if: github.event.label.name == 'coder'
    steps:
      - name: Coder Create Agent Chat
        uses: coder/create-agent-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          chat-prompt: "Read ${{ github.event.issue.html_url }} using gh CLI and write an appropriate plan for solving the issue to PLAN.md, then wait for feedback."
          github-url: ${{ github.event.issue.html_url }}
          github-token: ${{ github.token }}
          comment-on-issue: true
```

### Using an existing workspace

```yaml
      - name: Coder Create Agent Chat
        uses: coder/create-agent-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          chat-prompt: "Fix the bug described in this issue."
          coder-username: "bot-user"
          workspace-id: ${{ secrets.WORKSPACE_ID }}
          github-url: ${{ github.event.issue.html_url }}
          github-token: ${{ github.token }}
```

### Sending a follow-up message

```yaml
      - name: Follow up on existing chat
        uses: coder/create-agent-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          chat-prompt: "Please also add unit tests for the changes."
          existing-chat-id: ${{ steps.create_chat.outputs.chat-id }}
          coder-username: "bot-user"
          github-url: ${{ github.event.issue.html_url }}
          github-token: ${{ github.token }}
```

### Wait for the chat to finish (`wait: complete`)

When `wait: complete` is set, the action polls the chat every 5
seconds until it reaches a terminal status (`waiting`, `completed`, or
`error`) or `wait-timeout-seconds` (default 600) elapses. This
replaces the inline polling loop used by reference workflows such as
[`coder/coder/.github/workflows/doc-check.yaml`](https://github.com/coder/coder/blob/main/.github/workflows/doc-check.yaml).

```yaml
      - name: Run doc-check via Coder Agent Chat
        uses: coder/create-agent-chat-action@v0
        with:
          coder-url: ${{ secrets.CODER_URL }}
          coder-token: ${{ secrets.CODER_TOKEN }}
          chat-prompt: |
            Use the doc-check skill to review PR #${{ github.event.pull_request.number }}.
          github-url: ${{ github.event.pull_request.html_url }}
          github-user-id: ${{ github.event.sender.id }}
          github-token: ${{ github.token }}
          wait: complete
          wait-timeout-seconds: 600
```

**Caveat on `waiting`:** the chats API surfaces both "agent finished"
and "agent waiting for human input" as the same `waiting` status. v0
treats `waiting` as terminal and exits successfully. A v1 platform
change will distinguish the two cases.

When the chat enters `error` or the timeout elapses, the action exits
non-zero and sets the `chat-error-kind` and `chat-error-message`
outputs even on the failure path so a follow-up step can branch on
them. `chat-error-kind=timeout` is reserved for the wait-timeout case;
other kinds are documented under [Outputs](#outputs).

## Inputs

| Name                  | Description                                                                                                                                                                              | Required | Default |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| chat-prompt           | Prompt to send to the agent chat. Templated by the workflow before being passed in.                                                                                                      | true     | -       |
| coder-token           | Coder session token used to authenticate with the Coder API.                                                                                                                             | true     | -       |
| coder-url             | Coder deployment URL.                                                                                                                                                                    | true     | -       |
| github-url            | GitHub issue or pull request URL to link the chat to. Used for the issue/PR comment and as the human-readable association in the chat label.                                             | true     | -       |
| github-token          | GitHub token used to post and update issue comments.                                                                                                                                     | true     | -       |
| github-user-id        | GitHub user ID to resolve to a Coder user. Deleted Coder users are filtered out. Mutually exclusive with coder-username.                                                                | false    | -       |
| coder-username        | Coder username to use directly. Mutually exclusive with github-user-id; useful for service-account workflows.                                                                            | false    | -       |
| coder-organization    | Coder organization name. Reserved; not yet wired through to chat creation, the action emits a warning if set.                                                                            | false    | -       |
| workspace-id          | Existing workspace ID to pin the chat to. If unset, Agents auto-provisions a workspace.                                                                                                  | false    | -       |
| model-config-id       | Model configuration ID to use for the chat.                                                                                                                                              | false    | -       |
| existing-chat-id      | Existing chat ID to send a follow-up message to instead of creating a new chat.                                                                                                          | false    | -       |
| comment-on-issue      | Whether to comment on the GitHub issue or pull request with the chat URL and status.                                                                                                     | false    | true    |
| wait                  | Wait mode. `none` (default) returns immediately. `complete` polls every 5 seconds until the chat reaches a terminal status (`waiting`, `completed`, `error`) or `wait-timeout-seconds` elapses. | false    | none    |
| wait-timeout-seconds  | Maximum seconds to wait when wait=complete before failing with a timeout.                                                                                                                | false    | 600     |
| idempotency-key       | Optional key used to deduplicate chats. Reserved; not yet wired, the action emits a warning if set and always creates a new chat.                                                        | false    | -       |

## Outputs

| Name                | Description                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| coder-username      | The Coder username resolved from the GitHub user.                                                                                                        |
| chat-id             | The chat ID.                                                                                                                                             |
| chat-url            | The URL to view the chat in Coder.                                                                                                                       |
| chat-created        | Whether the chat was newly created (true) or a message was sent to an existing chat (false).                                                             |
| chat-status         | Current chat status (waiting, pending, running, paused, completed, error).                                                                               |
| chat-title          | The chat title.                                                                                                                                          |
| workspace-id        | The workspace ID the chat is running in (auto-provisioned or provided).                                                                                  |
| pull-request-url    | URL of the pull request or branch page when the chat has tracked changes.                                                                                |
| pull-request-state  | Pull request state (open, closed, merged) when available.                                                                                                |
| pull-request-title  | Title of the pull request when available.                                                                                                                |
| pull-request-number | Pull request number when available.                                                                                                                      |
| diff-additions      | Number of lines added in tracked changes.                                                                                                                |
| diff-deletions      | Number of lines deleted in tracked changes.                                                                                                              |
| diff-changed-files  | Number of files changed in tracked changes.                                                                                                              |
| head-branch         | Head branch name when available.                                                                                                                         |
| base-branch         | Base branch name when available.                                                                                                                         |
| chat-error-kind     | Machine-readable error kind when the chat fails (one of `spend_exceeded`, `user_not_found`, `user_ambiguous`, `org_not_found` (reserved, not yet emitted), `api_error`, `timeout`). |
| chat-error-message  | Human-readable error message when the chat fails.                                                                                                        |

## Failure-path comment

When the action fails to create a chat and `comment-on-issue` is `true`, the
action posts a comment describing the failure on the linked issue or pull
request, sets the `chat-error-kind` and `chat-error-message` outputs, and
still exits non-zero (the workflow run still fails red). Re-running the same
workflow updates the prior failure comment in place via a hidden marker so
comments do not stack.

### `chat-error-kind` values

| Value             | Meaning                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `spend_exceeded`  | The Coder deployment's chat spend limit has been reached. The comment includes spent and limit amounts.       |
| `user_not_found`  | No Coder user matched the GitHub identity. Adjust `github-user-id` or pass `coder-username` directly.         |
| `user_ambiguous`  | Multiple Coder users matched the same GitHub identity. Set `coder-username` to disambiguate.                  |
| `org_not_found`   | Reserved: the resolved Coder user has no matching organization. Not yet emitted by the action; will fire once organization wiring lands. |
| `api_error`       | Any other Coder API error. The comment includes the underlying message.                                       |
| `timeout`         | `wait: complete` polling did not reach a terminal status before `wait-timeout-seconds` elapsed. |

The `org_not_found` value is a reserved enum member and not yet emitted
by the action; it will fire once organization wiring lands.

### Comment marker

Failure-path comments end with a hidden HTML marker so the action can find
and update the prior comment on re-run without posting a new one each time:

```text
<!-- coder-agent-chat-action:<key> -->
```

The `<key>` is the value of `idempotency-key` when set, otherwise a
stable per-target key derived from `github-url` of the form
`<owner>/<repo>#<number>:<workflow-name>`, where `<workflow-name>` is
the `name:` field of the workflow (from `GITHUB_WORKFLOW`). The
workflow suffix is omitted when the env var is unset.

Scoping by workflow means two workflows targeting the same issue or
pull request maintain separate failure comments. To intentionally
share one comment across workflows, set `idempotency-key` to
the same value in each workflow. If two workflow files share the
same `name:`, their markers will collide; give them distinct names.
