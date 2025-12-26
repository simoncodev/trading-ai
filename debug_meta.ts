
import { Hyperliquid } from 'hyperliquid';

async function main() {
  const sdk = new Hyperliquid({ enableWs: false });
  const meta = await sdk.info.perpetuals.getMeta();
  console.log(JSON.stringify(meta.universe[0], null, 2)); // Print first asset (usually BTC)
}

main().catch(console.error);
