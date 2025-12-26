
import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkNetwork(name: string, isTestnet: boolean) {
    console.log(`\n=== CHECKING ${name} ===`);
    const privateKey = process.env.HYPERLIQUID_SECRET;
    const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS;
    
    if (!walletAddress || !privateKey) return;

    const sdk = new Hyperliquid({
        privateKey,
        testnet: isTestnet,
        walletAddress: walletAddress,
        enableWs: false,
    });

    try {
        console.log(`Fetching state for ${walletAddress}...`);
        const perpState = await sdk.info.perpetuals.getClearinghouseState(walletAddress);
        console.log(`${name} Account Value:`, perpState.marginSummary.accountValue);
        console.log(`${name} Withdrawable:`, perpState.withdrawable);
        if (parseFloat(perpState.marginSummary.accountValue) > 0) {
            console.log(`\n🎉 FOUND FUNDS ON ${name}!`);
            console.log(JSON.stringify(perpState, null, 2));
        }
    } catch (error: any) {
        console.error(`Error on ${name}:`, error.message);
    }
}

async function main() {
  await checkNetwork('MAINNET', false);
  await checkNetwork('TESTNET', true);
}

main();
