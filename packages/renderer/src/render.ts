import { DEFAULT_THEME } from "./theme.js";

export type RenderBackend = "text-stub";

export interface RenderSpec {
  kind: "graph" | "card";
  title: string;
  subtitle?: string;
  payload: unknown;
}

export interface RenderOptions {
  backend?: RenderBackend;
  themeOverride?: Partial<typeof DEFAULT_THEME>;
}

export function renderImage(spec: RenderSpec, options: RenderOptions = {}): Promise<Buffer> {
  // Placeholder backend: emit a text-based representation to keep flows working until
  // a real renderer (e.g., node-canvas or vega-lite) is wired in.
  const backend = options.backend ?? "text-stub";
  const theme = { ...DEFAULT_THEME, ...(options.themeOverride ?? {}) };
  if (backend === "text-stub") {
    const lines = [
      `[${spec.kind}] ${spec.title}`,
      spec.subtitle ? spec.subtitle : "",
      `theme primary ${theme.colors.primary}`,
      JSON.stringify(spec.payload, null, 2)
    ].filter(Boolean);
    return Promise.resolve(Buffer.from(lines.join("\n")));
  }
  return Promise.resolve(Buffer.from(""));
}

export function renderCard(options: RenderSpec): Promise<Buffer> {
  return renderImage(options);
}
