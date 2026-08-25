export type RenderResult
  = | { ok: true; text: string; }
    | { ok: false; unknown: string[]; };

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export const placeholdersIn = (template: string): string[] => {
  const names = new Set<string>();

  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];

    if (name !== undefined) names.add(name);
  }

  return [...names];
};

export const render = (template: string, values: Record<string, string>): RenderResult => {
  const unknown: string[] = [];

  const text = template.replaceAll(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];

    if (value === undefined) {
      unknown.push(name);

      return "";
    }

    return value;
  });

  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, text };
};
