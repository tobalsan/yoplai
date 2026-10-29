import type { GatewayConfig } from "@yoplai/shared";

export const DEFAULT_AVATAR_STYLE = "3d";

export type AvatarStyle = { id: string; label: string; prompt: string };

const BUILTIN_STYLES: AvatarStyle[] = [
  {
    id: "3d",
    label: "3D animated",
    prompt:
      "Stylized 3D animated feature-film character, soft cinematic lighting, smooth skin shading, expressive eyes, warm friendly expression, softly blurred modern workplace background with props that hint at the job",
  },
  {
    id: "manga",
    label: "Manga",
    prompt:
      "Japanese manga and anime illustration, clean line art, cel shading, large expressive eyes, vibrant colors, simple gradient background",
  },
  {
    id: "flat",
    label: "Flat illustration",
    prompt:
      "Flat vector illustration, simple geometric shapes, limited harmonious palette, no outlines, plain solid color background",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    prompt:
      "Soft watercolor portrait, visible paper texture, gentle color washes, muted palette, light background",
  },
  {
    id: "pixel",
    label: "Pixel art",
    prompt: "16-bit pixel art portrait, crisp pixels, limited palette, retro video game style, plain background",
  },
];

/** Built-in styles, overridden or extended by `avatars.styles` in the gateway config. */
export function listAvatarStyles(config: Pick<GatewayConfig, "avatars">): AvatarStyle[] {
  const styles = new Map(BUILTIN_STYLES.map((style) => [style.id, style]));
  for (const [id, prompt] of Object.entries(config.avatars?.styles ?? {})) {
    styles.set(id, { id, label: styles.get(id)?.label ?? id, prompt });
  }
  return [...styles.values()];
}

export function defaultAvatarStyle(config: Pick<GatewayConfig, "avatars">): string {
  return config.avatars?.style ?? DEFAULT_AVATAR_STYLE;
}

export class UnknownAvatarStyleError extends Error {
  constructor(readonly style: string) {
    super(`Unknown avatar style "${style}"`);
  }
}

export function resolveAvatarStyle(config: Pick<GatewayConfig, "avatars">, styleId?: string): AvatarStyle {
  const id = styleId ?? defaultAvatarStyle(config);
  const style = listAvatarStyles(config).find((candidate) => candidate.id === id);
  if (!style) throw new UnknownAvatarStyleError(id);
  return style;
}
