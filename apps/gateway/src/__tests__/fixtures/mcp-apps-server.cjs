async function main() {
  const fs = await import("node:fs");
  const readline = await import("node:readline");
  const path = await import("node:path");
  const { setTimeout } = await import("node:timers");
  const process = await import("node:process");
  const resourceUri = "ui://drawing/view";
  const tools = [
    { name: "draw", description: "Create a drawing", inputSchema: { type: "object" }, _meta: { ui: { resourceUri, visibility: ["model", "app"] } } },
    { name: "edit_in_view", description: "Edit the drawing in its view", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
    { name: "model_report", description: "Report to the model", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["model"] } } },
  ];
  const counterFile = process.env.MCP_APPS_COUNTER_FILE || (process.env.YOPLAI_HOME && path.join(process.env.YOPLAI_HOME, "mcp-apps-fixture-counters.json"));
  const counts = counterFile && fs.existsSync(counterFile)
    ? JSON.parse(fs.readFileSync(counterFile, "utf8"))
    : { model: 0, app: 0 };
  let drawingNumber = counts.model;

  function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (process.env.MCP_APPS_TRANSCRIPT) {
      fs.appendFileSync(process.env.MCP_APPS_TRANSCRIPT, JSON.stringify(message) + "\n");
    }
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "mcp-apps-fixture", version: "1" } });
    } else if (message.method === "tools/list") {
      send(message.id, { tools });
    } else if (message.method === "resources/read" && message.params.uri === "ui://drawing/hang") {
      // Deliberately never answers; the host/gateway must remain responsive.
      return;
    } else if (message.method === "resources/read" && message.params.uri === resourceUri) {
      send(message.id, { contents: [{
        uri: resourceUri,
        mimeType: "text/html;profile=mcp-app",
        text: fs.readFileSync(path.join(path.dirname(process.argv[1]), "mcp-apps-view.html"), "utf8"),
        _meta: { ui: { prefersBorder: true, csp: {
          connectDomains: ["https://api.example.test"],
          resourceDomains: ["https://static.example.test"],
          frameDomains: ["https://frames.example.test"],
          baseUriDomains: ["https://base.example.test"],
        } } },
      }] });
    } else if (message.method === "tools/call" && tools.some((tool) => tool.name === message.params.name)) {
      if (message.params.arguments?.hang === true) return;
      if (message.params.name === "edit_in_view") counts.app++;
      else counts.model++;
      if (counterFile) fs.writeFileSync(counterFile, JSON.stringify(counts));
      const reply = () => send(message.id, {
        content: [{ type: "text", text: "Fixture drawing ready" }],
        structuredContent: { drawingId: `drawing-${++drawingNumber}`, tool: message.params.name },
        _meta: { fixtureReplayValue: "raw-view-state" },
      });
      if (message.params.name === "draw" && process.env.MCP_APPS_DRAW_DELAY_MS) setTimeout(reply, Number(process.env.MCP_APPS_DRAW_DELAY_MS));
      else reply();
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown fixture operation" } }) + "\n");
    }
  });
}

void main();
