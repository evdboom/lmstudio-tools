const TOOL_PREFIX_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateToolPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix === "") return undefined;
  if (!TOOL_PREFIX_RE.test(prefix)) {
    throw new Error(
      `Invalid tool prefix: ${JSON.stringify(prefix)}. Use lowercase letters, digits, underscores, or hyphens, starting with a letter or digit.`
    );
  }
  return prefix;
}

export function prefixedToolName(name: string, prefix?: string): string {
  return prefix ? `${prefix}_${name}` : name;
}

export interface ToolPrefixOptions {
  prefix?: string;
}
