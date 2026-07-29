import { stripBase } from "./path";

const sectionRoutes: Array<[RegExp, string]> = [
  [/^\/agents\/[^/]+\/extensions\/[^/]+\/config$/, "Extension Config"],
  [/^\/agents\/[^/]+\/extensions\/[^/]+$/, "Extension"],
  [/^\/agents\/[^/]+\/edit$/, "Edit Agent"],
  [/^\/agents$/, "Agents"],
  [/^\/teams$/, "Teams"],
  [/^\/admin\/users$/, "Users"],
  [/^\/login$/, "Sign in"],
];

export function buildTitle(segments: (string | undefined | null)[]): string {
  return [
    ...segments
      .filter((segment): segment is string => Boolean(segment?.trim()))
      .map((segment) => segment.trim()),
    "Yoplai",
  ].join(" — ");
}

export function sectionForPath(pathname: string): string | undefined {
  const path = stripBase(pathname);
  return sectionRoutes.find(([pattern]) => pattern.test(path))?.[1];
}

export function documentTitle(options: {
  pathname: string;
  brandingName?: string | null;
  agentName?: string | null;
  devPrefix?: string;
}): string {
  const path = stripBase(options.pathname);
  const agentName = /^\/chat\/[^/]+(?:\/[^/]+)?$/.test(path)
    ? options.agentName
    : undefined;
  const title = buildTitle([
    agentName,
    sectionForPath(path),
    options.brandingName,
  ]);
  return `${options.devPrefix ?? ""}${title}`;
}
