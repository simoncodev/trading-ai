import { hyperliquidService } from '../services/hyperliquidService';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HyperliquidService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMarkets', () => {
    it('should fetch and transform market data', async () => {
      const mockResponse = {
        data: [
          {
            name: 'BTC-USD',
            coin: 'BTC',
            szDecimals: '0.001',
            maxLeverage: '10',
            tickSize: '0.01',
            onlyIsolated: false,
          },
        ],
      };

      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue(mockResponse),
        interceptors: {
          request: { use: jest.fn() },
          response: { use: jest.fn() },
        },
      } as any);

      const markets = await hyperliquidService.getMarkets();
      expect(markets).toHaveLength(1);
      expect(markets[0].symbol).toBe('BTC-USD');
    });
  });
});
