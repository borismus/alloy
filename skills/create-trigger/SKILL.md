---
name: create-trigger
description: Create recurring background tasks that run on a schedule.
---

# Create Trigger Skill

Help users set up recurring triggered tasks that run automatically in the background.

## What is a Trigger?

A trigger is a scheduled task that:
1. Runs at a specified interval (e.g., every hour, daily, weekly)
2. Evaluates a prompt you define
3. Decides whether to respond based on conditions in the prompt
4. Saves responses when triggered

## Gathering Requirements

When a user wants to create a trigger, gather this information:

1. **Title**: A descriptive name (e.g., "Daily News Digest", "Bitcoin Price Alert")

2. **Trigger Prompt**: What to check and when to respond
   - Be specific about conditions that warrant a response
   - Include any URLs or APIs to check
   - Describe the desired output format

3. **Interval**: How often should it run?
   - Hourly: 60 minutes
   - Every 6 hours: 360 minutes
   - Daily: 1440 minutes
   - Weekly: 10080 minutes

4. **Model** (optional): Which AI model to use. If not specified, use the default.

## Creating the Trigger

Generate a unique ID and write the trigger YAML file:

```yaml
id: "YYYY-MM-DD-HHMM-XXXX"  # Generate: date-time-4random_hex_chars
created: "ISO_TIMESTAMP"
updated: "ISO_TIMESTAMP"
title: "User's Title"
model: "provider/model-id"  # e.g., "anthropic/claude-sonnet-4-5-20250929"
trigger:
  enabled: true
  triggerPrompt: "The prompt to evaluate..."
  intervalMinutes: 60
messages: []
```

Use `write_file` with path `triggers/{id}.yaml` to create the trigger.

## Example Trigger Prompts

### News Digest (always responds)
"Search for the top 5 technology news stories from today. Summarize each in 2-3 sentences. Always respond with the digest."

### Price Alert (conditional)
"Check the current Bitcoin price. Only respond if the price has changed more than 5% since the last check. Include the current price and percentage change."

### Website Monitor (conditional)
"Fetch https://example.com and check if the content has changed significantly. Only respond if you detect meaningful changes. Summarize what changed."

## Tips for Good Prompts

1. **Be explicit**: "Only respond if..." or "Always respond with..."
2. **Include sources**: URLs, APIs, or search queries to use
3. **Specify format**: How should the response be structured?
4. **Match interval to data**: Don't check hourly if data changes daily
