#!/usr/bin/env bash
# Deploys both SBF programs to devnet with the synced program keypairs.
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/navguard"
solana config set --url https://api.devnet.solana.com >/dev/null
solana balance
solana program deploy target/deploy/navguard.so \
  --program-id target/deploy/navguard-keypair.json --with-compute-unit-price 1000
solana program deploy target/deploy/reference_vault.so \
  --program-id target/deploy/reference_vault-keypair.json --with-compute-unit-price 1000
solana balance
echo DEPLOY_OK
