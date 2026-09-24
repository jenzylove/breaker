#!/usr/bin/env bash
# Starts a local validator with NAVGuard and the reference vault preloaded.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/navguard"
NAVGUARD_ID=$(solana-keygen pubkey target/deploy/navguard-keypair.json)
VAULT_ID=$(solana-keygen pubkey target/deploy/reference_vault-keypair.json)
pkill -f solana-test-validator || true
rm -rf /tmp/ngledger
nohup solana-test-validator --reset --quiet --ledger /tmp/ngledger \
  --bpf-program "$NAVGUARD_ID" target/deploy/navguard.so \
  --bpf-program "$VAULT_ID" target/deploy/reference_vault.so \
  > /tmp/validator.log 2>&1 &
for i in $(seq 1 30); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 2; done
solana config set --url localhost >/dev/null
solana airdrop 100 >/dev/null
solana balance
solana program show "$NAVGUARD_ID" | head -3
solana program show "$VAULT_ID" | head -3
echo LOCALNET_READY
