
import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkBalance() {
    const privateKey = process.env.HYPERLIQUID_SECRET;
    const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS || '';
    
    const sdk = new Hyperliquid({
        privateKey,
        testnet: false,
        walletAddress,
        enableWs: false,
    });

    try {
        console.log(`Fetching account state for ${walletAddress}...`);
        const clearinghouseState = await sdk.info.perpetuals.getClearinghouseState(walletAddress);
        
        console.log('--- Clearinghouse State ---');
        console.log('Margin Summary:', JSON.stringify(clearinghouseState.marginSummary, null, 2));
        console.log('Withdrawable:', clearinghouseState.withdrawable);
        console.log('Cross Margin Summary:', JSON.stringify(clearinghouseState.crossMarginSummary, null, 2));
        console.log('Asset Positions:', JSON.stringify(clearinghouseState.assetPositions, null, 2));

        const openOrders = await sdk.info.getUserOpenOrders(walletAddress);
        console.log('Open Orders:', JSON.stringify(openOrders, null, 2));
        
        const accountValue = parseFloat(clearinghouseState.marginSummary.accountValue);
        const withdrawable = parseFloat(clearinghouseState.withdrawable);
        const totalMarginUsed = parseFloat(clearinghouseState.marginSummary.totalMarginUsed);
        
        console.log('--- Calculated Values ---');
        console.log(`Account Value (Equity): ${accountValue}`);
        console.log(`Withdrawable (Available): ${withdrawable}`);
        console.log(`Total Margin Used: ${totalMarginUsed}`);
        
    } catch (error) {
        console.error('Error fetching balance:', error);
    }
}

checkBalance();
