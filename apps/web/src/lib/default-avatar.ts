const DEFAULT_AVATAR_COUNT = 10;

/** FNV-1a, 32 bits, unsigned, over the UTF-8 bytes of the text. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Image of an agent that has no avatar. The full wire agent ID picks one of the bundled images,
 * so the same agent shows the same image on every load. The image is served by the local UI origin.
 */
export function defaultAvatarNumber(agentId: string): number {
  return (fnv1a(agentId) % DEFAULT_AVATAR_COUNT) + 1;
}

export function defaultAvatarUrl(agentId: string): string {
  return avatarFaceUrl(defaultAvatarNumber(agentId));
}

export function avatarFaceUrl(number: number): string {
  return `${import.meta.env.BASE_URL}avatars/default-${number}.webp`;
}
