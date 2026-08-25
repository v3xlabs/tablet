import { createMemo, createSignal, For, Show } from "solid-js";

export type Stop = {
  name: string;
  minutes: number;
};

type RouteProps = {
  stops: Stop[];
  limit: number;
};

export const Route = (props: RouteProps) => {
  const [expanded, setExpanded] = createSignal(false);

  const visible = createMemo(() => (expanded() ? props.stops : props.stops.slice(0, props.limit)));

  const total = createMemo(() => props.stops.reduce((sum, stop) => sum + stop.minutes, 0));

  return (
    <section class="route">
      <h3>Route ({total()} min)</h3>
      <ol>
        <For each={visible()}>
          {stop => (
            <li>
              <span>{stop.name}</span>
              <span class="minutes">{stop.minutes} min</span>
            </li>
          )}
        </For>
      </ol>
      <Show when={props.stops.length > props.limit}>
        <button onClick={() => setExpanded(value => !value)}>
          {expanded() ? "Show fewer" : "Show all"}
        </button>
      </Show>
    </section>
  );
};
