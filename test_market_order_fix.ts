import { hyperliquidService } from './src/services/hyperliquidService';
import * as dotenv from 'dotenv';

dotenv.config();

async function testMarketOrderFix() {
    try {
        console.log('\n========== TESTING MARKET ORDER FIX ==========\n');

        // Test 1: Place a market BUY order using the fixed logic
        console.log('--- TEST 1: Market BUY Order (useLimit=false) ---');
        try {
            const buyResult = await hyperliquidService.placeOrder(
                'BTC-PERP',  // symbol
                'buy',       // side
                0.001,       // quantity
                undefined,   // price - will be calculated
                false,       // useLimit=false for market order
                false        // reduceOnly
            );
            console.log('✅ Market BUY Result:', JSON.stringify(buyResult, null, 2));
        } catch (e: any) {
            console.log('❌ Market BUY Error:', e?.message || e);
        }

        // Test 2: Place a market SELL order
        console.log('\n--- TEST 2: Market SELL Order (useLimit=false) ---');
        try {
            const sellResult = await hyperliquidService.placeOrder(
                'ETH-PERP',  // symbol
                'sell',      // side
                0.01,        // quantity
                undefined,   // price - will be calculated
                false,       // useLimit=false for market order
                false        // reduceOnly
            );
            console.log('✅ Market SELL Result:', JSON.stringify(sellResult, null, 2));
        } catch (e: any) {
            console.log('❌ Market SELL Error:', e?.message || e);
        }

        // Test 3: Get bid/ask for BTC to verify the calculation
        console.log('\n--- TEST 3: Verify Bid/Ask Spread (for reference) ---');
        const bidAsk = await hyperliquidService.getBestBidAsk('BTC-PERP');
        console.log('BTC-PERP Best Bid:', bidAsk.bid);
        console.log('BTC-PERP Best Ask:', bidAsk.ask);
        console.log('BTC-PERP Spread:', bidAsk.spread);
        
        // Show what price a market buy would use
        const slippage = 0.005; // 0.5%
        const buyPrice = bidAsk.ask * (1 + slippage);
        const sellPrice = bidAsk.bid * (1 - slippage);
        console.log(`Market BUY would use: ${buyPrice} (ask + 0.5%)`);
        console.log(`Market SELL would use: ${sellPrice} (bid - 0.5%)`);

        console.log('\n========== TEST COMPLETE ==========\n');

    } catch (error: any) {
        console.error('Fatal error:', error?.message || error);
        process.exit(1);
    }
}

testMarketOrderFix().catch(console.error);
