export interface NarrativeTemplate {
  title: string;
  body: string;
}

export function formatNarrative(template: NarrativeTemplate): string {
  return `${template.title}\n\n${template.body}`;
}
