
import { hyperliquidService } from './src/services/hyperliquidService';
import * as dotenv from 'dotenv';

dotenv.config();

async function testLeverage() {
    try {
        console.log('Testing setLeverage...');
        const result = await hyperliquidService.setLeverage('BTC-USDC', 40);
        console.log('Result:', result);
    } catch (error) {
        console.error('Error:', error);
    }
}

testLeverage();
