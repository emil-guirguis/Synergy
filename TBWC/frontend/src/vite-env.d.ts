/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_APP_VERSION_INFO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
