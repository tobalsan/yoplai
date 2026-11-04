import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

// Browser acceptance fixture; observations remain visible through the app's DOM.
const state = {
  events: [] as string[],
  initialize: 0,
  initializationTotal: 0,
  input: 0,
  result: 0,
  teardown: 0,
  storage: "",
  chatStorageBlocked: false,
  chatCookiesBlocked: false,
  undeclaredFetch: "pending",
  appCalls: 0,
  modelDenied: false,
  forged: 0,
  height: 240,
  lastError: "",
  arguments: {} as unknown,
  toolResult: {} as unknown,
  lastHostContext: {} as unknown,
  messagesAccepted: 0,
  resetRefused: false,
  spamAccepted: 0,
  spamRefused: 0,
  contextUpdates: 0,
  messageToken: "ALG600-message-2b-a7f3",
  contextToken: "ALG600-context-2b-c91e",
};

function render() {
  document.querySelector("#state")!.textContent = JSON.stringify(state, null, 2);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  if (event.data.result?.protocolVersion === "2026-01-26") {
    state.initialize++;
    state.initializationTotal = Number(localStorage.getItem("mcp-fixture-initializations") ?? "0") + 1;
    localStorage.setItem("mcp-fixture-initializations", String(state.initializationTotal));
    state.events.push("initialize");
    render();
  }
});

const app = new App({ name: "Yoplai SDK fixture", version: "1" }, {
  availableDisplayModes: ["inline", "fullscreen"],
}, { autoResize: false });
app.addEventListener("hostcontextchanged", () => {
  state.lastHostContext = app.getHostContext();
  render();
});
app.addEventListener("toolinput", (params) => {
  state.input++;
  state.events.push("input");
  state.arguments = params.arguments;
  render();
});
app.addEventListener("toolresult", (params) => {
  state.result++;
  state.events.push("result");
  state.toolResult = params;
  render();
});
app.onteardown = () => {
  state.teardown++;
  state.events.push("teardown");
  render();
  return {};
};

function button(id: string, work: () => Promise<void>) {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.onclick = () => {
    void work().catch((error: unknown) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      render();
    });
  };
}

button("app-tool", async () => {
  const result = await app.callServerTool({ name: "edit_in_view", arguments: { label: "app click" } });
  if (result.isError) throw new Error("App-only tool returned an error");
  state.appCalls++;
  await app.sendLog({ level: "info", data: { event: "fixture.app-click", appCalls: state.appCalls } });
  render();
});
button("model-tool", async () => {
  try {
    await app.callServerTool({ name: "model_report", arguments: {} });
    state.lastError = "Model-only tool unexpectedly allowed";
  } catch {
    state.modelDenied = true;
  }
  render();
});
button("forge", async () => {
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: "<h1>Forged replacement</h1>" } }, "*");
  state.forged++;
  render();
});
button("resize", async () => {
  state.height = 600;
  await app.sendSizeChanged({ height: 600 });
  render();
});
button("hang", async () => {
  await app.readServerResource({ uri: "ui://drawing/hang" });
});
button("fullscreen", async () => {
  await app.requestDisplayMode({ mode: "fullscreen" });
});
button("inline", async () => {
  await app.requestDisplayMode({ mode: "inline" });
});
button("send-message", async () => {
  const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: `Reply with exactly ${state.messageToken}` }] });
  if (result.isError) throw new Error("Host refused message");
  state.messagesAccepted++;
  render();
});
button("send-reset", async () => {
  try {
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: "/reset" }] });
    state.resetRefused = result.isError === true;
  } catch (error: unknown) {
    state.resetRefused = true;
    state.lastError = error instanceof Error ? error.message : String(error);
  }
  render();
});
button("spam", async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => app.sendMessage({
    role: "user", content: [{ type: "text", text: `Acknowledge ALG600-spam-${index} briefly.` }],
  })));
  state.spamAccepted = results.filter((result) => result.status === "fulfilled" && !result.value.isError).length;
  state.spamRefused = 20 - state.spamAccepted;
  render();
});
button("set-context", async () => {
  await app.updateModelContext({ content: [{ type: "text", text: `App-selected token: ${state.contextToken}` }] });
  state.contextUpdates++;
  render();
});

async function connect() {
  localStorage.setItem("mcp-fixture-storage", "apps-origin-value");
  state.storage = localStorage.getItem("mcp-fixture-storage") ?? "";
  try { void window.top!.localStorage; } catch { state.chatStorageBlocked = true; }
  try { void window.top!.document.cookie; } catch { state.chatCookiesBlocked = true; }
  await app.connect();
  state.lastHostContext = app.getHostContext();
  await app.sendSizeChanged({ height: 240 });
  render();
  try {
    await fetch("https://undeclared.invalid/mcp-app-csp-probe");
    state.undeclaredFetch = "allowed";
  } catch {
    state.undeclaredFetch = "blocked";
  }
  render();
}

void connect().catch((error: unknown) => {
  state.lastError = error instanceof Error ? error.message : String(error);
  render();
});
