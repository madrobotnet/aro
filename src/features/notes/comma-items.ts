/** The existing comma field's parsing and acknowledgement merge rules. */
export function parseCommaItems(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function mergeCommaItems(value: string, baseValue: string, incomingValue: string): string[] {
  const base = new Set(parseCommaItems(baseValue));
  const incoming = parseCommaItems(incomingValue).filter((item) => !base.has(item));
  return [...new Set([...parseCommaItems(value), ...incoming])];
}

export function addTags(tags: readonly string[], value: string): string[] {
  return mergeCommaItems([...tags, ...parseCommaItems(value)].join(", "), "", "");
}

export function removeTag(tags: readonly string[], index: number): string[] {
  return tags.filter((_, at) => at !== index);
}
