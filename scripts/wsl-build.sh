#!/usr/bin/env bash
# Builds both programs to SBF inside WSL and keeps declare_id! in sync with the
# deploy keypairs in target/deploy.
set -e
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$HOME/navguard"
mkdir -p target/deploy

sync_id() {
  local name=$1 src=$2
  local kp="target/deploy/${name}-keypair.json"
  [ -f "$kp" ] || solana-keygen new --no-bip39-passphrase --silent -o "$kp"
  local id
  id=$(solana-keygen pubkey "$kp")
  sed -i "s/declare_id!(\"[A-Za-z0-9]*\")/declare_id!(\"$id\")/" "$src"
  echo "$name $id"
}

sync_id navguard programs/navguard/src/lib.rs
sync_id reference_vault programs/reference-vault/src/lib.rs

(cd programs/navguard && cargo-build-sbf --sbf-out-dir ../../target/deploy)
(cd programs/reference-vault && cargo-build-sbf --sbf-out-dir ../../target/deploy)
ls -la target/deploy/*.so
echo BUILD_OK
