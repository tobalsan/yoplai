import { lazy } from "solid-js";

const WebhooksConfigPage = lazy(() => import("../../pages/WebhooksConfig"));

export const webRouteExtension = {
  extensionId: "webhooks",
  routes: [],
  configRoute: {
    path: "/agents/:agentId/extensions/webhooks",
    component: WebhooksConfigPage,
  },
};
