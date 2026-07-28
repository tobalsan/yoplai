const basePath = import.meta.env.BASE_URL?.replace(/\/+$/, "") ?? "";

export function stripBase(pathname: string): string {
  if (basePath && pathname.startsWith(basePath)) {
    return pathname.slice(basePath.length) || "/";
  }
  return pathname;
}
