import { ToolResult } from '../../../types/tools';

// Lazy import to avoid circular dependency issues
let _skillRegistry: typeof import('../../skills').skillRegistry | null = null;

async function getSkillRegistry() {
  if (!_skillRegistry) {
    const { skillRegistry } = await import('../../skills');
    _skillRegistry = skillRegistry;
  }
  return _skillRegistry;
}

export async function executeSkillTools(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  if (toolName !== 'use_skill') {
    return {
      tool_use_id: '',
      content: `Unknown skill tool: ${toolName}`,
      is_error: true,
    };
  }

  const skillName = input.name as string;
  if (!skillName) {
    return {
      tool_use_id: '',
      content: 'Missing required parameter: name',
      is_error: true,
    };
  }

  const skillRegistry = await getSkillRegistry();
  const instructions = skillRegistry.getSkillInstructions(skillName);
  if (!instructions) {
    const availableSkills = skillRegistry.getSkills().map(s => s.name);
    return {
      tool_use_id: '',
      content: `Unknown skill: ${skillName}. Available skills: ${availableSkills.join(', ')}`,
      is_error: true,
    };
  }

  return {
    tool_use_id: '',
    content: `# Skill: ${skillName}\n\nFollow these instructions to complete the task:\n\n${instructions}`,
  };
}
