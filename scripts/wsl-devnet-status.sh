#!/usr/bin/env bash
# Reports the devnet payer and what the two deploys will cost.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/breaker"
solana config set --url https://api.devnet.solana.com >/dev/null
echo "payer:  $(solana address)"
echo "balance: $(solana balance)"
total=0
for f in target/deploy/breaker.so target/deploy/reference_pool.so; do
  sz=$(stat -c%s "$f")
  rent=$(solana rent "$sz" | grep -i 'rent-exempt minimum' | awk '{print $4}')
  echo "$(basename "$f")  ${sz} bytes  rent-exempt ${rent} SOL"
  total=$(echo "$total + $rent" | bc -l)
done
echo "approximate deploy cost: ${total} SOL"
