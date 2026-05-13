# AGENTS.md - AI Agent Guide for agents-chat-action

## Repository Overview

**Purpose**: GitHub Action that creates and manages Coder Agents chats for GitHub users with automated issue commenting support.

**Key Difference from create-task-action**: This action targets the Coder Agents Chat API (`/api/experimental/chats`) instead of the Tasks API. Agents purposefully does NOT expose template selection — it either auto-provisions a workspace or uses an existing one.

**Tech Stack**:
- **Runtime**: Bun (JavaScript/TypeScript runtime & bundler)
- **Language**: TypeScript with strict mode enabled
- **Validation**: Zod for runtime schema validation
- **Testing**: Bun's built-in test runner
- **GitHub Integration**: @actions/core, @actions/github, @octokit/rest
- **Formatting/Linting**: Biome

---

## Architecture

### High-Level Flow

```
GitHub Event (issue created/labeled)
    ↓
index.ts (Entry Point)
    ↓
Parse & Validate Inputs (schemas.ts)
    ↓
Initialize Clients (CoderClient, Octokit)
    ↓
CoderAgentChatAction.run() (action.ts)
    ↓
├─ Get Coder user by GitHub ID (or use provided username)
├─ Parse GitHub issue URL
├─ Check if existing-chat-id provided
│  ├─ YES: Send message to existing chat
│  └─ NO: Look up existing chat by reuse labels (unless force-new-chat)
│         ├─ Match: Send message to reused chat
│         └─ No match: Create new chat (Agents auto-provisions workspace)
└─ Comment on GitHub issue with chat URL
```

### Key Design Decisions

1. **No Template Selection**: Agents auto-chooses workspace infrastructure
2. **Optional Workspace ID**: Can pin to existing workspace via `workspace-id`
3. **Chat API**: Uses `/api/experimental/chats` (not Tasks API)
4. **Dependency Injection**: All external dependencies injected for testability
5. **Schema Validation**: Zod schemas ensure type safety at runtime

---

## File Guide

### Core Source Files (src/)

- **index.ts** - Entry point, parses GHA inputs, initializes clients, runs action
- **action.ts** - Core business logic: user resolution, chat creation, issue commenting
- **coder-client.ts** - Coder API client for Chat endpoints + user lookup
- **schemas.ts** - Zod schemas for action inputs and outputs

### Test Files (src/*.test.ts)

- **test-helpers.ts** - Mock objects, helper factories, test data
- **action.test.ts** - Tests for CoderAgentChatAction
- **coder-client.test.ts** - Tests for RealCoderClient API interactions
- **schemas.test.ts** - Tests for input/output schema validation

---

## Development Workflow

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type checking
bun run typecheck

# Lint
bun run lint

# Format code
bun run format

# Build for production
bun run build
```

## API Endpoints Used

- **Stable API**:
  - `GET /api/v2/users?q=github_com_user_id:{id}` - User lookup
- **Experimental API**:
  - `POST /api/experimental/chats` - Create chat
  - `POST /api/experimental/chats/{id}/messages` - Send message
  - `GET /api/experimental/chats/{id}` - Get chat
  - `GET /api/experimental/chats` - List chats
