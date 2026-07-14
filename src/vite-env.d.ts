/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin when deployed as a separate service, e.g. https://carb-cap-trade-api.onrender.com */
  readonly VITE_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
