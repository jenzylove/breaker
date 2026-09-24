#!/usr/bin/env bash
# Deploys both programs to devnet with the synced program keypairs.
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/breaker"
solana config set --url https://api.devnet.solana.com >/dev/null
echo "balance before: $(solana balance)"

solana program deploy target/deploy/breaker.so \
  --program-id target/deploy/breaker-keypair.json --with-compute-unit-price 1000
solana program deploy target/deploy/reference_pool.so \
  --program-id target/deploy/reference_pool-keypair.json --with-compute-unit-price 1000

echo "balance after: $(solana balance)"
solana program show "$(solana-keygen pubkey target/deploy/breaker-keypair.json)" | head -4
solana program show "$(solana-keygen pubkey target/deploy/reference_pool-keypair.json)" | head -4
echo DEPLOY_OK
