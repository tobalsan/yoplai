import { within } from "@testing-library/dom";

/** The sources of the default avatar images inside `root`. An avatar image has an empty or a descriptive alt text. */
export function defaultAvatarSources(root: HTMLElement): string[] {
  const screen = within(root);
  return [...screen.queryAllByRole("presentation", { hidden: true }), ...screen.queryAllByRole("img", { hidden: true })]
    .map((image) => image.getAttribute("src") ?? "")
    .filter((source) => /avatars\/default-\d+\.webp$/.test(source));
}
