export function isDesktopWindow(): boolean {
  return /\bElectron\//.test(globalThis.navigator?.userAgent ?? "");
}
