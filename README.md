# Coder Agent Chat GitHub Action

This GitHub action creates a [Coder Agent Chat](https://coder.com/docs/ai-coder) and optionally posts a comment on a GitHub issue. It's designed to be used as part of a wider workflow.

## Overview

- When creating a Coder Agent Chat, you must specify either the GitHub user ID or the Coder username as an input.
- The action then queries the Coder deployment to find the Coder user associated with the given GitHub user ID.
  - Note that this requires the Coder deployment to be configured with [GitHub OAuth](https://coder.com/docs/admin/external-auth#configure-a-github-oauth-app) and for the Coder user to have linked their GitHub account.
  - If no corresponding Coder user is found, the action will fail.
- The action will then create a [Coder Agent Chat](https://coder.com/docs/ai-coder) with the given prompt.
  - Unlike Tasks, **Agents does not require specifying a template**. Agents auto-provisions a workspace, or you can pass an existing `workspace-id`.
- Once the chat has been created successfully, the action will post a comment on the GitHub issue with the chat URL.
- You can also send a follow-up message to an existing chat by providing `existing-chat-id`.

## Requirements

- A running Coder deployment with Agents enabled (experimental).
- A Coder session token with the required permissions to:
  - Read all users in the given organization
  - Create chats

## Example Usage

The below example will start a Coder Agent Chat when the `coder` label is applied to an issue.

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
          github-issue-url: ${{ github.event.issue.html_url }}
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
          github-issue-url: ${{ github.event.issue.html_url }}
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
          github-issue-url: ${{ github.event.issue.html_url }}
          github-token: ${{ github.token }}
```

## Inputs

| Name              | Description                                                                 | Required | Default   |
| ----------------- | --------------------------------------------------------------------------- | -------- | --------- |
| chat-prompt       | Prompt/instructions to send to the agent chat                               | true     | -         |
| coder-token       | Coder session token for authentication                                      | true     | -         |
| coder-url         | Coder deployment URL                                                        | true     | -         |
| github-issue-url  | GitHub issue URL to link this chat to                                       | true     | -         |
| github-token      | GitHub token for API operations                                             | true     | -         |
| github-user-id    | GitHub user ID to create chat for                                           | false    | -         |
| coder-username    | Coder username (alternative to github-user-id)                              | false    | -         |
| coder-organization| Coder organization name                                                     | false    | "default" |
| workspace-id      | Existing workspace ID (if not provided, Agents auto-provisions)             | false    | -         |
| model-config-id   | Model configuration ID to use                                               | false    | -         |
| existing-chat-id  | Existing chat ID to send a follow-up message to                             | false    | -         |
| comment-on-issue  | Whether to comment on the GitHub issue                                      | false    | true      |

## Outputs

| Name           | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| coder-username | The Coder username resolved from GitHub user                         |
| chat-id        | The chat ID                                                          |
| chat-url       | The URL to view the chat in Coder                                    |
| chat-created   | Whether the chat was newly created (true) or already existed (false) |
