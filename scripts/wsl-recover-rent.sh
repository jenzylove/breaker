#!/usr/bin/env bash
# Reports recoverable devnet rent: stranded deploy buffers, plus the exact cost
# of the two Breaker deploys. Read-only; closes nothing on its own.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana config set --url https://api.devnet.solana.com >/dev/null

echo "payer:   $(solana address)"
echo "balance: $(solana balance)"

echo
echo "=== stranded deploy buffers ==="
solana program show --buffers 2>/dev/null || echo "(none)"

echo
echo "=== exact deploy cost ==="
for f in "$HOME/breaker/target/deploy/breaker.so" "$HOME/breaker/target/deploy/reference_pool.so"; do
  sz=$(stat -c%s "$f")
  # solana program deploy allocates 2x by default for upgrade headroom.
  echo "$(basename "$f")  ${sz} bytes"
  echo "    default (2x headroom): $(solana rent $((sz * 2)) 2>/dev/null | head -2 | tail -1)"
  echo "    exact (--max-len):     $(solana rent "$sz" 2>/dev/null | head -2 | tail -1)"
done
