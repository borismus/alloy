# Testing Guide

This directory contains unit tests for the core functionality of Alloy.

## Running Tests

```bash
# Run tests in watch mode (interactive)
npm test

# Run tests once
npm run test:run

# Run tests with UI
npm run test:ui
```

## Test Structure

### Service Tests

- **[vault.test.ts](../services/vault.test.ts)** - Tests for VaultService
  - Vault folder selection and initialization
  - Config loading and saving (YAML)
  - Memory file operations
  - Conversation persistence and retrieval
  - Directory structure management

- **[claude.test.ts](../services/claude.test.ts)** - Tests for ClaudeService
  - Client initialization with API keys
  - Message sending and streaming
  - Response chunk handling
  - Error handling
  - Model selection

### Test Utilities

- **[setup.ts](./setup.ts)** - Test environment setup
  - Mocks for Tauri APIs (fs, dialog, path)
  - Global test configuration

- **[mocks.ts](./mocks.ts)** - Mock data factories
  - `createMockConversation()` - Generate test conversations
  - `createMockConfig()` - Generate test configs
  - `createMockFileSystemEntry()` - Generate file system entries

## Coverage

The tests cover all core business logic:

- ✅ VaultService (36 tests)
  - Vault initialization and setup
  - Config file management
  - Conversation CRUD operations
  - Memory file handling

- ✅ ClaudeService (11 tests)
  - API client initialization
  - Message streaming
  - Error handling
  - Response processing

## Writing New Tests

When adding new features, follow these patterns:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { YourService } from './your-service';

describe('YourService', () => {
  let service: YourService;

  beforeEach(() => {
    service = new YourService();
    vi.clearAllMocks();
  });

  it('should do something', () => {
    // Arrange
    const input = 'test';

    // Act
    const result = service.doSomething(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

## Mocking Tauri APIs

Tauri APIs are automatically mocked in [setup.ts](./setup.ts). To customize mock behavior in individual tests:

```typescript
import * as fs from '@tauri-apps/plugin-fs';
import { vi } from 'vitest';

vi.mocked(fs.readTextFile).mockResolvedValue('mock content');
```

## Notes

- Tests run in a Node.js environment using happy-dom
- Tauri APIs are mocked since they require the Tauri runtime
- UI components are not tested (focus is on core business logic)
- All async operations use proper async/await patterns
