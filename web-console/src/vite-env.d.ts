/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Select the data backend: "api" (default) or "mock". */
  readonly VITE_DATA_SOURCE?: "api" | "mock";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
