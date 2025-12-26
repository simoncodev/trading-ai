
import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkSdk() {
    const privateKey = process.env.HYPERLIQUID_SECRET;
    const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;
    
    const sdk = new Hyperliquid({
        privateKey,
        testnet: false,
        walletAddress,
        enableWs: false,
    });

    console.log('SDK keys:', Object.keys(sdk));
    if (sdk.exchange) {
        console.log('Exchange keys:', Object.keys(sdk.exchange));
        // @ts-ignore
        console.log('Has updateLeverage:', typeof sdk.exchange.updateLeverage);
        // @ts-ignore
        console.log('Has updateIsolatedMargin:', typeof sdk.exchange.updateIsolatedMargin);
    }
    if (sdk.info) {
        console.log('Info keys:', Object.keys(sdk.info));
    }
}

checkSdk().catch(console.error);
