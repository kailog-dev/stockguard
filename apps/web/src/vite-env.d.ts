/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin when the web app is hosted separately (empty = same origin / Vite proxy). */
  readonly VITE_API_BASE?: string;
  readonly VITE_BASE_BUILDER_CODE?: string;
  readonly VITE_STOCKGUARD_REGISTRY_ADDRESS?: string;
  /** 'base' (mainnet) or 'base-sepolia' */
  readonly VITE_STOCKGUARD_CHAIN?: string;
  /** Public Telegram alert channel link, e.g. https://t.me/stockguard_alerts */
  readonly VITE_TELEGRAM_URL?: string;
  /** Your public build-in-public X profile */
  readonly VITE_X_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: import('viem').EIP1193Provider;
}
