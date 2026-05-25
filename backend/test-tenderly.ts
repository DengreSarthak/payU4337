import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { simulate } from "./src/tenderly";

async function testTenderly() {
  try {
    // Simple ETH transfer simulation as a smoke test
    const sim = await simulate({
      network_id: "11155111", // Sepolia
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      input: "0x",
      value: "0",
      gas: 21_000,
    });

    console.log("✅ Tenderly simulation OK:", sim.ok);
    console.log("   URL:", sim.url ?? "no URL");
  } catch (e: any) {
    console.error("❌ Tenderly failed:", e.message);
    process.exit(1);
  }
}

testTenderly();
