export default {
  id: "desktop-fixture",
  displayName: "Desktop Fixture",
  description: "Checks the packaged catalog.",
  dependencies: [],
  routePrefixes: ["/api/desktop-fixture"],
  configSchema: { parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) },
  registerRoutes: (api) => api.get("/desktop-fixture", (c) => c.text("DESKTOP FIXTURE")),
  validateConfig: () => ({ valid: true, errors: [] }),
  capabilities: () => [],
  start: async () => {},
  stop: async () => {},
};
