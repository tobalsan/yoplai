import { For, Show } from "solid-js";
import type { Suggestion } from "@yoplai/shared/types";

export function SuggestionCards(props: {
  suggestions: Suggestion[];
  onSelect: (prompt: string) => void;
}) {
  return (
    <Show when={props.suggestions.length > 0}>
      <div class="suggestion-cards" aria-label="Suggested prompts">
        <p class="suggestion-cards-lead">What would you like to do?</p>
        <For each={props.suggestions}>
          {(suggestion) => (
            <button
              type="button"
              class="suggestion-card"
              onClick={() => props.onSelect(suggestion.prompt)}
            >
              <span class="suggestion-card-title">{suggestion.title}</span>
              <i class="fa-solid fa-arrow-right suggestion-card-icon" aria-hidden="true" />
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
