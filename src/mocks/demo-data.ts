/**
 * Demo vault data for browser-only mode
 *
 * Pre-populated with sample conversations, notes, and config
 * to allow UI development and testing without a real filesystem.
 */

import { DEMO_VAULT_PATH } from './index';

const CONFIG_YAML = `defaultModel: anthropic/claude-sonnet-4-20250514
favoriteModels:
  - anthropic/claude-sonnet-4-20250514
  - openai/gpt-4o
# Demo mode: fake key so UI is accessible (actual API calls will fail)
ANTHROPIC_API_KEY: demo-key-for-ui-testing
`;

const MEMORY_MD = `# Memory

## About This Demo
This is a demo vault running in browser-only mode.
No API keys are configured, so chat functionality is disabled.
You can still explore the UI and test interactions.

## User Preferences
- Prefers concise responses
- Uses markdown formatting
`;

const CONVERSATION_1 = `id: 2025-01-15-1000-abc12
created: "2025-01-15T10:00:00.000Z"
updated: "2025-01-15T10:05:00.000Z"
model: anthropic/claude-sonnet-4-20250514
title: Welcome to Orchestra
messages:
  - role: user
    timestamp: "2025-01-15T10:00:00.000Z"
    content: Hello! Can you explain what this app does?
  - role: assistant
    timestamp: "2025-01-15T10:00:15.000Z"
    content: |
      Orchestra is a local-first AI chat application that stores all your conversations as plain text files in a vault directory on your computer.

      Key features:
      - **Multi-provider support**: Works with Anthropic Claude, OpenAI GPT, Google Gemini, and local Ollama models
      - **Local storage**: All conversations are saved as YAML files you own
      - **Skills system**: Extensible capabilities like web search and file reading
      - **Model comparison**: Compare responses from different AI models side-by-side
      - **Obsidian integration**: Conversations are also saved as markdown for viewing in Obsidian
`;

const CONVERSATION_2 = `id: 2025-01-14-1430-def34
created: "2025-01-14T14:30:00.000Z"
updated: "2025-01-14T14:45:00.000Z"
model: openai/gpt-4o
title: Code Review Example
messages:
  - role: user
    timestamp: "2025-01-14T14:30:00.000Z"
    content: |
      Can you review this function?

      \`\`\`typescript
      function add(a, b) {
        return a + b;
      }
      \`\`\`
  - role: assistant
    timestamp: "2025-01-14T14:30:20.000Z"
    content: |
      Here's my review of the function:

      **Issues:**
      1. No TypeScript types - parameters and return type should be typed
      2. No input validation for edge cases

      **Suggested improvement:**
      \`\`\`typescript
      function add(a: number, b: number): number {
        return a + b;
      }
      \`\`\`

      This adds type safety and makes the function's contract explicit.
`;

const CONVERSATION_3 = `id: 2025-01-13-0900-ghi56
created: "2025-01-13T09:00:00.000Z"
updated: "2025-01-13T09:02:00.000Z"
model: anthropic/claude-sonnet-4-20250514
title: Quick Question
messages:
  - role: user
    timestamp: "2025-01-13T09:00:00.000Z"
    content: What's the capital of France?
  - role: assistant
    timestamp: "2025-01-13T09:00:05.000Z"
    content: The capital of France is Paris.
`;

const NOTE_1 = `# Sample Note

This is a sample note in the demo vault.

## Features
- Notes support full markdown
- They can be linked from conversations
- The app watches for changes

## Example List
1. First item
2. Second item
3. Third item
`;

const SKILL_MEMORY = `---
name: memory
description: Reads memory.md into context at conversation start.
trigger: start
---

# Memory Skill

This skill loads the contents of memory.md into the conversation context
when a new conversation starts, giving the AI persistent context about
the user's preferences and background.
`;

// Build the demo vault filesystem
export const demoVault: Record<string, string> = {
  [`${DEMO_VAULT_PATH}/config.yaml`]: CONFIG_YAML,
  [`${DEMO_VAULT_PATH}/memory.md`]: MEMORY_MD,
  [`${DEMO_VAULT_PATH}/conversations/2025-01-15-1000-abc12-welcome-to-orchestra.yaml`]: CONVERSATION_1,
  [`${DEMO_VAULT_PATH}/conversations/2025-01-14-1430-def34-code-review-example.yaml`]: CONVERSATION_2,
  [`${DEMO_VAULT_PATH}/conversations/2025-01-13-0900-ghi56-quick-question.yaml`]: CONVERSATION_3,
  [`${DEMO_VAULT_PATH}/notes/sample-note.md`]: NOTE_1,
  [`${DEMO_VAULT_PATH}/skills/memory/SKILL.md`]: SKILL_MEMORY,
};

// Directories that should exist (for exists() checks and readDir())
export const demoDirs = new Set([
  DEMO_VAULT_PATH,
  `${DEMO_VAULT_PATH}/conversations`,
  `${DEMO_VAULT_PATH}/conversations/attachments`,
  `${DEMO_VAULT_PATH}/notes`,
  `${DEMO_VAULT_PATH}/skills`,
  `${DEMO_VAULT_PATH}/skills/memory`,
  `${DEMO_VAULT_PATH}/triggers`,
]);
