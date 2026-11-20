import { render } from "solid-js/web";
import App from "./App";
import { fadeInDesktopWindow } from "./lib/desktop-window";

const root = document.getElementById("root")!;
fadeInDesktopWindow(root);
render(() => <App />, root);
