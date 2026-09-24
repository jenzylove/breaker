// Does an issuer halt reach the chain? For every stock xStocks has halted,
// reads its Solana mint and reports whether the Token-2022 Pausable extension
// (type 26) is set. A halt that leaves the mint unpaused leaves the token
// tradable in any pool, which is the gap Breaker closes.
//
// usage: node scripts/check-issuer-pause.mjs

const U = "https://breaker-one.vercel.app";
const stocks = (await (await fetch(`${U}/api/stocks`)).json()).stocks;
const pick = stocks.filter((s) => s.halted).concat(stocks.filter((s) => ["TSLAx", "NVDAx", "AAPLx"].includes(s.symbol)));
const res = await fetch(`${U}/api/rpc?cluster=mainnet`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [pick.map((s) => s.mint), { encoding: "base64" }] }),
});
const accounts = (await res.json()).result.value;
pick.forEach((s, i) => {
  const a = accounts[i];
  if (!a) return console.log(s.symbol, "no account");
  const d = Buffer.from(a.data[0], "base64");
  const supply = d.readBigUInt64LE(36);
  const freeze = d.readUInt32LE(46) === 1;
  let paused = "no Pausable extension";
  for (let o = 166; o + 4 <= d.length; ) {
    const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2);
    if (type === 26) paused = d[o + 4 + 32] === 1 ? "PAUSED" : "not paused";
    o += 4 + len;
  }
  console.log(s.symbol.padEnd(8), s.halted ? "issuer: HALTED " : "issuer: open   ", "| mint:", paused, "| freeze authority:", freeze, "| supply:", supply.toString());
});
