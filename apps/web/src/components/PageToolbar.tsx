import { children, createContext, createSignal, onCleanup, useContext, type Accessor, type JSX, type ParentProps } from "solid-js";

const ToolbarContext = createContext<(content: Accessor<JSX.Element>) => void>();

/** The active page owns the toolbar content. Its layout owns the header. */
export function PageToolbarSlot(props: { children: (toolbar: Accessor<JSX.Element>) => JSX.Element }) {
  const [toolbar, setToolbar] = createSignal<Accessor<JSX.Element>>();
  const register = (content: Accessor<JSX.Element>) => {
    setToolbar(() => content);
    onCleanup(() => setToolbar((current) => current === content ? undefined : current));
  };

  return <ToolbarContext.Provider value={register}>
    {props.children(() => toolbar()?.())}
  </ToolbarContext.Provider>;
}

export function PageToolbar(props: ParentProps) {
  const register = useContext(ToolbarContext);
  if (register) register(children(() => props.children));
  return null;
}
