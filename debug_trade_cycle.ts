
import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

const COIN = 'BTC-PERP'; // Hyperliquid symbol
const SIZE = 0.0002; // Very small size for testing (~$17 at $85k)
// Note: Hyperliquid min order value is usually $10. 0.0002 * 85000 = 17. Safe.

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const privateKey = process.env.HYPERLIQUID_SECRET;
    const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;
    const isTestnet = process.env.HYPERLIQUID_API_URL?.includes('testnet') || false;

    if (!walletAddress || !privateKey) {
        console.error('Missing credentials in .env');
        return;
    }

    console.log('--- Configuration ---');
    console.log(`Network: ${isTestnet ? 'TESTNET' : 'MAINNET'}`);
    console.log(`Wallet: ${walletAddress}`);
    console.log(`Symbol: ${COIN}`);
    console.log(`Size: ${SIZE} BTC`);

    const sdk = new Hyperliquid({
        privateKey,
        testnet: isTestnet,
        walletAddress: walletAddress,
        enableWs: false,
    });

    try {
        // 1. Get Current Price
        console.log('\n1. Fetching Orderbook...');
        const l2Book = await sdk.info.getL2Book(COIN);
        const bestAsk = parseFloat(l2Book.levels[1][0].px);
        const bestBid = parseFloat(l2Book.levels[0][0].px);
        console.log(`Best Bid: ${bestBid}, Best Ask: ${bestAsk}`);

        // 2. Open Position (Market Buy)
        // We simulate Market Buy by placing Limit IOC at 5% higher than ask
        const buyPrice = Math.round(bestAsk * 1.05); 
        console.log(`\n2. Opening Position (Market Buy ~${buyPrice})...`);
        
        const buyOrder = {
            coin: COIN,
            is_buy: true,
            sz: SIZE,
            limit_px: buyPrice,
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: false,
        };

        const buyResult = await sdk.exchange.placeOrder(buyOrder);
        
        if (buyResult.status === 'ok' && buyResult.response.type === 'order') {
            const status = buyResult.response.data.statuses[0];
            if (status.error) {
                console.error('❌ Buy Order Failed:', status.error);
                return;
            }
            console.log('✅ Buy Order Filled:', JSON.stringify(status));
        } else {
            console.error('❌ Buy Order Error:', buyResult);
            return;
        }

        // 3. Wait 5 seconds
        console.log('\n3. Waiting 5 seconds...');
        await sleep(5000);

        // 4. Close Position (Market Sell)
        // We simulate Market Sell by placing Limit IOC at 5% lower than bid
        // Re-fetch price to be safe
        const l2BookClose = await sdk.info.getL2Book(COIN);
        const closeBid = parseFloat(l2BookClose.levels[0][0].px);
        const sellPrice = Math.round(closeBid * 0.95);

        console.log(`\n4. Closing Position (Market Sell ~${sellPrice})...`);

        const sellOrder = {
            coin: COIN,
            is_buy: false,
            sz: SIZE,
            limit_px: sellPrice,
            order_type: { limit: { tif: 'Ioc' as const } },
            reduce_only: true, // Good practice for closing
        };

        const sellResult = await sdk.exchange.placeOrder(sellOrder);

        if (sellResult.status === 'ok' && sellResult.response.type === 'order') {
            const status = sellResult.response.data.statuses[0];
            if (status.error) {
                console.error('❌ Sell Order Failed:', status.error);
                return;
            }
            console.log('✅ Sell Order Filled (Position Closed):', JSON.stringify(status));
        } else {
            console.error('❌ Sell Order Error:', sellResult);
        }

    } catch (error: any) {
        console.error('CRITICAL ERROR:', error.message || error);
    }
}

main();
