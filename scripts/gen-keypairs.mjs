// Generates program keypairs into .demo/ (gitignored) and prints their ids.
import { Keypair } from "@solana/web3.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".demo");
mkdirSync(dir, { recursive: true });

for (const name of ["breaker", "reference_pool"]) {
  const path = join(dir, `${name}-keypair.json`);
  if (existsSync(path)) {
    const { default: kp } = { default: null };
    console.log(`${name}: keypair already exists, leaving it alone`);
    continue;
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`${name} ${kp.publicKey.toBase58()}`);
}
