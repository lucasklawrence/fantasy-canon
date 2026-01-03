export interface RenderOptions {
  title: string;
  subtitle?: string;
}

export function renderCard(options: RenderOptions): Promise<Buffer> {
  // Rendering will be implemented later; return empty buffer for now
  void options;
  return Promise.resolve(Buffer.from(""));
}
