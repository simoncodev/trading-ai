
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

    // Get current prices via L2 book
    console.log('\n--- Getting Current Market Data via L2 Book ---');
    const l2Book = await sdk.info.getL2Book('BTC-PERP');
    const bids = l2Book?.levels?.[0] || [];
    const asks = l2Book?.levels?.[1] || [];
    
    if (bids.length > 0 && asks.length > 0) {
        const bidPrice = parseFloat(bids[0].px);
        const askPrice = parseFloat(asks[0].px);
        const markPrice = (bidPrice + askPrice) / 2;
        
        console.log('Best Bid:', bidPrice);
        console.log('Best Ask:', askPrice);
        console.log('Mark Price (mid):', markPrice);
        console.log('Spread (Ask - Bid):', askPrice - bidPrice);

        // Test 1: Limit IOC exactly at mark price
        console.log('\n--- TEST 1: LIMIT IOC exactly at mark price ---');
        const iocAtMark = {
            coin: 'BTC-PERP',
            is_buy: true,
            sz: 0.001,
            limit_px: Math.floor(markPrice),
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: false,
        };
        console.log('Sending Limit IOC at', Math.floor(markPrice), ':', iocAtMark);
        try {
            const result1 = await sdk.exchange.placeOrder(iocAtMark);
            console.log('✅ Result:', JSON.stringify(result1, null, 2));
        } catch (e: any) {
            console.log('❌ Error:', e?.message || e);
        }

        // Test 2: Limit IOC at +3% from mark (within 5% boundary)
        console.log('\n--- TEST 2: LIMIT IOC at +3% from mark (WITHIN limit) ---');
        const ioc3PercentHigh = {
            coin: 'BTC-PERP',
            is_buy: true,
            sz: 0.001,
            limit_px: Math.floor(markPrice * 1.03),
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: false,
        };
        console.log('Sending Limit IOC at', Math.floor(markPrice * 1.03), ':', ioc3PercentHigh);
        try {
            const result2 = await sdk.exchange.placeOrder(ioc3PercentHigh);
            console.log('✅ Result:', JSON.stringify(result2, null, 2));
        } catch (e: any) {
            console.log('❌ Error:', e?.message || e);
        }

        // Test 3: Limit IOC at -2% from mark (for selling)
        console.log('\n--- TEST 3: LIMIT IOC at -2% from mark (SELL order) ---');
        const ioc2PercentLow = {
            coin: 'BTC-PERP',
            is_buy: false,
            sz: 0.001,
            limit_px: Math.floor(markPrice * 0.98),
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: false,
        };
        console.log('Sending Limit IOC Sell at', Math.floor(markPrice * 0.98), ':', ioc2PercentLow);
        try {
            const result3 = await sdk.exchange.placeOrder(ioc2PercentLow);
            console.log('✅ Result:', JSON.stringify(result3, null, 2));
        } catch (e: any) {
            console.log('❌ Error:', e?.message || e);
        }

        // Test 4: Limit IOC at +5% from mark (at the boundary)
        console.log('\n--- TEST 4: LIMIT IOC at +5% from mark (BOUNDARY) ---');
        const ioc5Percent = {
            coin: 'BTC-PERP',
            is_buy: true,
            sz: 0.001,
            limit_px: Math.floor(markPrice * 1.05),
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: false,
        };
        console.log('Sending Limit IOC at', Math.floor(markPrice * 1.05), ':', ioc5Percent);
        try {
            const result4 = await sdk.exchange.placeOrder(ioc5Percent);
            console.log('✅ Result:', JSON.stringify(result4, null, 2));
        } catch (e: any) {
            console.log('❌ Error:', e?.message || e);
        }

        // Test 5: Limit IOC at +6% from mark (OVER the boundary - should fail)
        console.log('\n--- TEST 5: LIMIT IOC at +6% from mark (OVER boundary) ---');
        const ioc6Percent = {
            coin: 'BTC-PERP',
            is_buy: true,
            sz: 0.001,
            limit_px: Math.floor(markPrice * 1.06),
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: false,
        };
        console.log('Sending Limit IOC at', Math.floor(markPrice * 1.06), ':', ioc6Percent);
        try {
            const result5 = await sdk.exchange.placeOrder(ioc6Percent);
            console.log('✅ Result:', JSON.stringify(result5, null, 2));
        } catch (e: any) {
            console.log('❌ Error:', e?.message || e);
        }
    } else {
        console.log('❌ Could not get order book data');
    }

  } catch (error: any) {
    console.error('Error:', error.message || error);
    if (error.response) {
        console.error('Response data:', error.response.data);
    }
  }
}

main();
