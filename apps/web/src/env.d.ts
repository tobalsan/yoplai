/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_YOPLAI_DEV?: string;
  readonly VITE_YOPLAI_UI_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
