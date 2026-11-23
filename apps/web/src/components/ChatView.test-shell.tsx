import type { ParentProps } from "solid-js";
import { PageToolbarSlot } from "./PageToolbar";

/** Renders the real toolbar slot for tests that do not need the sidebar. */
export function ToolbarOnlyShell(props: ParentProps) {
  return <PageToolbarSlot>{(toolbar) => <><header>{toolbar()}</header>{props.children}</>}</PageToolbarSlot>;
}
