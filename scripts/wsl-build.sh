#!/usr/bin/env bash
# Builds both programs to SBF inside WSL and keeps declare_id! in sync with the
# deploy keypairs in target/deploy. The keypairs generated on the Windows side
# land in .demo/, so they are copied in first and stay the source of truth for
# the program ids.
set -e
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/breaker"
mkdir -p target/deploy

adopt_keypair() {
  local name=$1
  local src=".demo/${name}-keypair.json"
  local kp="target/deploy/${name}-keypair.json"
  if [ -f "$src" ] && [ ! -f "$kp" ]; then
    cp "$src" "$kp"
  fi
  [ -f "$kp" ] || solana-keygen new --no-bip39-passphrase --silent -o "$kp"
}

sync_id() {
  local name=$1 src=$2
  adopt_keypair "$name"
  local id
  id=$(solana-keygen pubkey "target/deploy/${name}-keypair.json")
  sed -i "s/declare_id!(\"[A-Za-z0-9]*\")/declare_id!(\"$id\")/" "$src"
  echo "$name $id"
}

sync_id breaker programs/breaker/src/lib.rs
sync_id reference_pool programs/reference-pool/src/lib.rs

(cd programs/breaker && cargo-build-sbf --sbf-out-dir ../../target/deploy)
(cd programs/reference-pool && cargo-build-sbf --sbf-out-dir ../../target/deploy)
ls -la target/deploy/*.so
echo BUILD_OK
