
import { hyperliquidService } from './src/services/hyperliquidService';

async function checkAccount() {
    try {
        const account = await hyperliquidService.getAccount();
        console.log('Account object:', JSON.stringify(account, null, 2));
    } catch (error) {
        console.error('Error fetching account:', error);
    }
}

checkAccount();
