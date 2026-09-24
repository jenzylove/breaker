/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional direct RPC override for local development. */
  readonly VITE_SOLANA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
