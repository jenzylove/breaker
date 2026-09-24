import { Buffer } from "buffer";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import App from "./App";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

// The wallet adapters expect Node's Buffer to exist.
globalThis.Buffer = globalThis.Buffer ?? Buffer;

/**
 * The console drives a venue on devnet. Mainnet is read separately, through the
 * server side proxy, because the console lists real tokenized equities but the
 * guard that acts on them is not deployed to mainnet.
 */
const DEVNET_RPC =
  import.meta.env.VITE_SOLANA_RPC_URL ?? `${window.location.origin}/api/rpc?cluster=devnet`;

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={DEVNET_RPC} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
