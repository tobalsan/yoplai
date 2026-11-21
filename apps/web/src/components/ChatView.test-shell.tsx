import type { JSX } from "solid-js";

/** A shell for ChatView tests that do not exercise the layout: it puts the toolbar above the chat, with no sidebar. */
export function ToolbarOnlyShell(props: { toolbar: JSX.Element; children: JSX.Element }) {
  return <><header>{props.toolbar}</header>{props.children}</>;
}
