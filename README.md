# Coder Agent Chat GitHub Action

This GitHub action creates a [Coder Agent Chat](https://coder.com/docs/ai-coder) and optionally posts a comment on a GitHub issue or pull request. It's designed to be used as part of a wider workflow.

## Overview

- Pass a `chat-prompt` and a `github-url` (issue or PR) and the action creates a Coder Agent Chat associated with that GitHub item.
- The action resolves the Coder user to run as. Either pass `github-user-id` (the action looks up the Coder user with that linked GitHub identity) or pass `coder-username` directly. The two inputs are mutually exclusive.
  - GitHub-id lookup requires the Coder deployment to be configured with [GitHub OAuth](https://coder.com/docs/admin/external-auth#configure-a-github-oauth-app) and for the Coder user to have linked their GitHub account.
  - Deleted Coder users are automatically excluded from the GitHub-id lookup, so a previously deleted account no longer causes an ambiguous-match error (closes [coder/create-task-action#8](https://github.com/coder/create-task-action/issues/8) for this action; the bug stays open in `create-task-action`).
- Unlike Tasks, **Agents does not require specifying a template**. Agents auto-provisions a workspace, or you can pass an existing `workspace-id`.
- After creation, the action posts a comment on the linked issue or pull request with the chat URL. Disable with `comment-on-issue: false`.
- Send a follow-up message to an existing chat by providing `existing-chat-id`.

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
          github-user-id: ${{ github.event.sender.id }}
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
| chat-error-kind     | Machine-readable error kind when the chat fails. Currently emits `api_error` (chat ended in error or polling failed) and `timeout` (wait=complete reached `wait-timeout-seconds`). |
| chat-error-message  | Human-readable error message when the chat fails.                                                                                                        |
