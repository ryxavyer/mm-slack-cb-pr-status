/**
 * Slack encodes user group mentions as <!subteam^GROUPID|@handle> in message
 * text. This extracts the bare handle (without @) for lookup against the team
 * map config.
 */
const GROUP_RE = /<!subteam\^[A-Z0-9]+\|@([\w.-]+)>/g;

export function parseGroupMentions(text: string | undefined | null): string[] {
  if (!text) return [];

  const handles: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(GROUP_RE)) {
    const handle = match[1]?.toLowerCase();
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
    }
  }

  return handles;
}
