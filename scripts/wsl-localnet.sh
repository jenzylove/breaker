#!/usr/bin/env bash
# Starts a local validator with Breaker and the reference pool preloaded.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/breaker"
BREAKER_ID=$(solana-keygen pubkey target/deploy/breaker-keypair.json)
POOL_ID=$(solana-keygen pubkey target/deploy/reference_pool-keypair.json)
pkill -f solana-test-validator || true
rm -rf /tmp/bkledger
nohup solana-test-validator --reset --quiet --ledger /tmp/bkledger \
  --bpf-program "$BREAKER_ID" target/deploy/breaker.so \
  --bpf-program "$POOL_ID" target/deploy/reference_pool.so \
  > /tmp/validator.log 2>&1 &
for i in $(seq 1 30); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 2; done
solana config set --url localhost >/dev/null
solana airdrop 100 >/dev/null
solana balance
solana program show "$BREAKER_ID" | head -3
solana program show "$POOL_ID" | head -3
echo LOCALNET_READY
