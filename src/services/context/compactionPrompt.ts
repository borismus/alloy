/**
 * Prompt for LLM-based conversation compaction.
 * Inspired by Claude Code's compact prompt — asks the model to summarize
 * older messages into a structured format that preserves key context.
 *
 * The <analysis> block serves as a drafting scratchpad — it improves
 * summary quality but gets stripped before the summary enters context.
 */

const NO_TOOLS_PREAMBLE = `IMPORTANT: Respond with TEXT ONLY. Do NOT call any tools.
You already have all the context you need in the conversation above.
Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

export const COMPACTION_PROMPT = `${NO_TOOLS_PREAMBLE}Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and key decisions that would be essential for continuing the conversation without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis:
1. Chronologically analyze each message, identifying:
   - The user's explicit requests and intents
   - Your approach to addressing them
   - Key decisions and technical details
   - Errors encountered and how they were resolved
   - Specific user feedback or corrections

Your summary should include these sections:

1. Primary Request and Intent: Capture all of the user's explicit requests in detail
2. Key Concepts: List important technical concepts, topics, and frameworks discussed
3. Important Details: Specific files, code, data, or references that were examined or discussed
4. Errors and Fixes: Errors encountered and how they were resolved, including user corrections
5. User Messages: List ALL user messages (not tool results) — these capture changing intent
6. Pending Tasks: Any tasks explicitly requested but not yet completed
7. Current Work: What was being worked on immediately before this summary, with specific details
8. Next Step: The most logical next step based on the most recent work (only if directly relevant to user's latest request)

<example>
<analysis>
[Your thought process ensuring all points are covered]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Concepts:
   - [Concept 1]
   - [Concept 2]

3. Important Details:
   - [Detail 1]
   - [Detail 2]

4. Errors and Fixes:
   - [Error]: [How it was fixed]

5. User Messages:
   - [Message 1]
   - [Message 2]

6. Pending Tasks:
   - [Task 1]

7. Current Work:
   [Description of current work]

8. Next Step:
   [Next step if applicable]
</summary>
</example>

Please provide your summary now.

REMINDER: Respond with plain text only — an <analysis> block followed by a <summary> block.`;

/**
 * Format the raw compaction output: strip the analysis scratchpad,
 * extract and clean up the summary.
 */
export function formatCompactSummary(raw: string): string {
  let result = raw;

  // Strip analysis section (drafting scratchpad)
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/, '');

  // Extract summary content
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    result = summaryMatch[1].trim();
  }

  // Clean up extra whitespace
  result = result.replace(/\n\n+/g, '\n\n');

  return result.trim();
}

/**
 * Wrap a compacted summary into a message-like format for injection
 * into the conversation context.
 */
export function createCompactionMessage(summary: string): string {
  return `This conversation was compacted from an earlier, longer exchange. The summary below covers what was discussed:

${summary}

Recent messages follow below.`;
}
