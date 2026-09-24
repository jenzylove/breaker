#!/usr/bin/env bash
# Installs Rust, the Agave Solana CLI, and Anchor inside WSL without sudo.
set -e
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
source "$HOME/.cargo/env"
rustc --version

if [ ! -x "$HOME/.local/share/solana/install/active_release/bin/solana" ]; then
  curl -sSfL https://release.anza.xyz/stable/install -o /tmp/agave-install.sh
  sh /tmp/agave-install.sh
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
grep -q active_release "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"
solana --version
cargo-build-sbf --version | head -1

if ! command -v anchor >/dev/null 2>&1; then
  cargo install --git https://github.com/solana-foundation/anchor avm --force --locked
  avm install 1.2.0
  avm use 1.2.0
fi
anchor --version
echo TOOLCHAIN_READY
