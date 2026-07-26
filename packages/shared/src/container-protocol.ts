export const CONTAINER_OUTPUT_START = "---YOPLAI_OUTPUT_START---";
export const CONTAINER_OUTPUT_END = "---YOPLAI_OUTPUT_END---";
export const CONTAINER_EVENT_PREFIX = "---YOPLAI_EVENT---";

// Legacy markers emitted by pre-rename container images. The host decoder
// must keep accepting these so an operator-pinned `aihub-agent:latest`
// image doesn't silently produce no output. Never emit these — new images
// only ever write the CONTAINER_* markers above.
export const LEGACY_CONTAINER_OUTPUT_START = "---AIHUB_OUTPUT_START---";
export const LEGACY_CONTAINER_OUTPUT_END = "---AIHUB_OUTPUT_END---";
export const LEGACY_CONTAINER_EVENT_PREFIX = "---AIHUB_EVENT---";
