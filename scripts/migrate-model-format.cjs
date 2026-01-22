#!/usr/bin/env node

/**
 * Migration script to convert conversation YAML files from old format to new unified model format.
 *
 * Old format:
 *   provider: anthropic
 *   model: claude-sonnet-4-5-20250929
 *
 * New format:
 *   model: anthropic/claude-sonnet-4-5-20250929
 *
 * Also migrates:
 * - comparison.models from [{provider, model}] to ["provider/model"]
 * - council.councilMembers from [{provider, model}] to ["provider/model"]
 * - council.chairman from {provider, model} to "provider/model"
 * - Message.provider + Message.model to Message.model: "provider/model"
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DRY_RUN = process.argv.includes('--dry-run');
const args = process.argv.filter(a => !a.startsWith('--'));
const CONVERSATIONS_DIR = args[2] || '/Users/smus/Documents/main/PromptBox/conversations';

function formatModelId(provider, modelId) {
  return `${provider}/${modelId}`;
}

function migrateConversation(conversation) {
  const conv = { ...conversation };
  let changed = false;

  // Migrate top-level provider/model to unified model string
  if (conv.provider && (!conv.model || !conv.model.includes('/'))) {
    conv.model = formatModelId(conv.provider, conv.model || '');
    delete conv.provider;
    changed = true;
  }

  // Migrate comparison metadata
  if (conv.comparison?.models) {
    const newModels = conv.comparison.models.map(m => {
      if (typeof m === 'object' && m.provider && m.model) {
        changed = true;
        return formatModelId(m.provider, m.model);
      }
      return m; // Already a string
    });
    conv.comparison = { ...conv.comparison, models: newModels };
  }

  // Migrate council metadata
  if (conv.council) {
    if (conv.council.councilMembers) {
      const newMembers = conv.council.councilMembers.map(m => {
        if (typeof m === 'object' && m.provider && m.model) {
          changed = true;
          return formatModelId(m.provider, m.model);
        }
        return m;
      });
      conv.council = { ...conv.council, councilMembers: newMembers };
    }
    if (conv.council.chairman && typeof conv.council.chairman === 'object') {
      const chairman = conv.council.chairman;
      if (chairman.provider && chairman.model) {
        conv.council = { ...conv.council, chairman: formatModelId(chairman.provider, chairman.model) };
        changed = true;
      }
    }
  }

  // Migrate message-level provider/model (for comparison/council messages)
  if (conv.messages) {
    conv.messages = conv.messages.map(msg => {
      if (msg.provider && msg.model && !msg.model.includes('/')) {
        const newMsg = { ...msg };
        newMsg.model = formatModelId(msg.provider, msg.model);
        delete newMsg.provider;
        changed = true;
        return newMsg;
      }
      return msg;
    });
  }

  // Migrate trigger format
  if (conv.trigger) {
    const trigger = { ...conv.trigger };
    if (trigger.triggerProvider && !trigger.triggerModel?.includes('/')) {
      trigger.triggerModel = formatModelId(trigger.triggerProvider, trigger.triggerModel);
      delete trigger.triggerProvider;
      changed = true;
    }
    if (trigger.mainProvider && !trigger.mainModel?.includes('/')) {
      trigger.mainModel = formatModelId(trigger.mainProvider, trigger.mainModel);
      delete trigger.mainProvider;
      changed = true;
    }
    conv.trigger = trigger;
  }

  return { conversation: conv, changed };
}

function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const conversation = yaml.load(content);

    if (!conversation) {
      console.log(`  Skipping ${path.basename(filePath)} (empty or invalid)`);
      return { skipped: true };
    }

    const { conversation: migrated, changed } = migrateConversation(conversation);

    if (changed) {
      if (DRY_RUN) {
        console.log(`  Would migrate: ${path.basename(filePath)}`);
      } else {
        const newContent = yaml.dump(migrated);
        fs.writeFileSync(filePath, newContent, 'utf8');
        console.log(`  Migrated: ${path.basename(filePath)}`);
      }
      return { migrated: true };
    } else {
      return { unchanged: true };
    }
  } catch (error) {
    console.error(`  Error processing ${path.basename(filePath)}: ${error.message}`);
    return { error: true };
  }
}

function main() {
  console.log(`\nMigrating conversation files in: ${CONVERSATIONS_DIR}`);
  if (DRY_RUN) {
    console.log('DRY RUN MODE - no files will be modified\n');
  }

  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    console.error(`Directory not found: ${CONVERSATIONS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(CONVERSATIONS_DIR)
    .filter(f => f.endsWith('.yaml'))
    .map(f => path.join(CONVERSATIONS_DIR, f));

  console.log(`Found ${files.length} YAML files\n`);

  const stats = { migrated: 0, unchanged: 0, skipped: 0, error: 0 };

  for (const file of files) {
    const result = processFile(file);
    if (result.migrated) stats.migrated++;
    if (result.unchanged) stats.unchanged++;
    if (result.skipped) stats.skipped++;
    if (result.error) stats.error++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Migrated: ${stats.migrated}`);
  console.log(`Unchanged: ${stats.unchanged}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.error}`);

  if (DRY_RUN) {
    console.log(`\nRun without --dry-run to apply changes.`);
  }
}

main();
