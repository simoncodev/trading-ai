
import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const privateKey = process.env.HYPERLIQUID_SECRET;
  const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;
  const isTestnet = process.env.HYPERLIQUID_API_URL?.includes('testnet') || false;

  if (!walletAddress || !privateKey) {
    console.error('Missing credentials');
    return;
  }

  const sdk = new Hyperliquid({
    privateKey,
    testnet: isTestnet,
    walletAddress: walletAddress,
    enableWs: false,
  });

  try {
    console.log('--- Fetching Meta ---');
    const meta = await sdk.info.perpetuals.getMeta();
    
    if (meta.universe.length > 0) {
        console.log('First 5 assets in universe:', meta.universe.slice(0, 5).map((u: any) => u.name));
    }

    const btcUniverse = meta.universe.find((u: any) => u.name === 'BTC-PERP');
    console.log('BTC Universe Info:', JSON.stringify(btcUniverse, null, 2));

    if (!btcUniverse) {
        console.error('BTC-PERP not found in universe');
        return;
    }

    // Test Order Placement (Limit Buy @ $1000)
    console.log('\n--- Placing Test Order (Limit Buy BTC-PERP @ $1000) ---');
    
    const orderRequest = {
        coin: 'BTC-PERP',
        is_buy: true,
        sz: 0.001, // Min size
        limit_px: 1000, // Deep OTM
        order_type: { limit: { tif: 'Gtc' as const } },
        reduce_only: false,
    };

    console.log('Sending order:', orderRequest);
    const result = await sdk.exchange.placeOrder(orderRequest);
    console.log('Order Result:', JSON.stringify(result, null, 2));

    if (result.status === 'ok') {
        const orderId = result.response.data.statuses[0].oid;
        console.log(`\n--- Cancelling Order ${orderId} ---`);
        const cancelResult = await sdk.exchange.cancelOrder({
            coin: 'BTC-PERP',
            o: orderId
        });
        console.log('Cancel Result:', JSON.stringify(cancelResult, null, 2));
    }

  } catch (error: any) {
    console.error('Error:', error.message || error);
    if (error.response) {
        console.error('Response data:', error.response.data);
    }
  }
}

main();
