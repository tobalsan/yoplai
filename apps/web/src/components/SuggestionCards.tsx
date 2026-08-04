import { For, Show } from "solid-js";
import type { Suggestion } from "@yoplai/shared/types";

export function SuggestionCards(props: {
  suggestions: Suggestion[];
  onSelect: (prompt: string) => void;
}) {
  return (
    <Show when={props.suggestions.length > 0}>
      <div class="suggestion-cards" aria-label="Suggested prompts">
        <For each={props.suggestions}>
          {(suggestion) => (
            <button
              type="button"
              class="suggestion-card"
              onClick={() => props.onSelect(suggestion.prompt)}
            >
              {suggestion.title}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
