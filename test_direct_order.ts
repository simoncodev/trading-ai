import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

async function testDirectOrder() {
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
        console.log('\n========== TESTING DIRECT SDK ORDERS ==========\n');

        // Get mark price
        const l2Book = await sdk.info.getL2Book('BTC-PERP');
        const bids = l2Book?.levels?.[0] || [];
        const asks = l2Book?.levels?.[1] || [];
        
        if (bids.length > 0 && asks.length > 0) {
            const bidPrice = parseFloat(bids[0].px);
            const askPrice = parseFloat(asks[0].px);
            const markPrice = (bidPrice + askPrice) / 2;
            
            console.log('BTC-PERP Best Bid:', bidPrice);
            console.log('BTC-PERP Best Ask:', askPrice);
            console.log('Mark Price:', markPrice);
            console.log('Mark Price + 3%:', Math.floor(markPrice * 1.03));

            // Test 1: Buy with +3% from mark
            console.log('\n--- TEST 1: Direct SDK - Market BUY at +3% ---');
            const buyPrice = Math.floor(markPrice * 1.03);
            const buyOrder = {
                coin: 'BTC-PERP',
                is_buy: true,
                sz: 0.001,
                limit_px: buyPrice,
                order_type: { limit: { tif: 'Ioc' as const } },
                reduce_only: false,
            };

            console.log(`Sending order with limit_px=${buyPrice}:`, buyOrder);
            const buyResult = await sdk.exchange.placeOrder(buyOrder);
            console.log('✅ BUY Result:', JSON.stringify(buyResult, null, 2));
        }

    } catch (error: any) {
        console.error('Error:', error?.message || error);
        process.exit(1);
    }
}

testDirectOrder().catch(console.error);
