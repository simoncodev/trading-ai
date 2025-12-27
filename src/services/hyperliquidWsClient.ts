import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { logger } from '../core/logger';

/**
 * HYPERLIQUID WEBSOCKET CLIENT
 * 
 * Minimal WS client for real-time BBO (Best Bid/Offer) data.
 * Replaces polling with streaming for order book top-of-book data.
 */

// ========================================
// TYPES
// ========================================

export interface BboData {
  bestBid: number;
  bestAsk: number;
  mid: number;
  ts: number;
}

export interface WsConfig {
  wsUrl: string;
  reconnectMaxDelayMs: number;
  staleMs: number;
}

// ========================================
// CONFIGURATION
// ========================================

const DEFAULT_CONFIG: WsConfig = {
  wsUrl: process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws',
  reconnectMaxDelayMs: parseInt(process.env.WS_RECONNECT_MAX_DELAY_MS || '30000', 10),
  staleMs: parseInt(process.env.WS_STALE_MS || '5000', 10),
};

// ========================================
// HYPERLIQUID WEBSOCKET CLIENT CLASS
// ========================================

class HyperliquidWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: WsConfig;
  private bboCache: Map<string, BboData> = new Map();
  private subscribedSymbols: Set<string> = new Set();
  private reconnectAttempt: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private lastError: string | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(wsConfig?: Partial<WsConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...wsConfig };
  }

  /**
   * Connect to WebSocket
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      logger.debug('[WsClient] Already connected or connecting');
      return;
    }

    logger.info(`[WsClient] Connecting to ${this.config.wsUrl}`);

    try {
      this.ws = new WebSocket(this.config.wsUrl);

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));
      this.ws.on('error', (err: Error) => this.handleError(err));
      this.ws.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason.toString()));
    } catch (err) {
      logger.error('[WsClient] Failed to create WebSocket', { error: String(err) });
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    logger.info('[WsClient] Disconnecting');
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.subscribedSymbols.clear();
    this.emit('status', { connected: false, reason: 'disconnected' });
  }

  /**
   * Subscribe to BBO for a symbol
   */
  subscribe(symbol: string): void {
    const coin = this.normalizeSymbol(symbol);
    
    if (this.subscribedSymbols.has(coin)) {
      logger.debug(`[WsClient] Already subscribed to ${coin}`);
      return;
    }

    this.subscribedSymbols.add(coin);

    if (this.isConnected && this.ws) {
      this.sendSubscription(coin);
    }
  }

  /**
   * Unsubscribe from BBO for a symbol
   */
  unsubscribe(symbol: string): void {
    const coin = this.normalizeSymbol(symbol);
    this.subscribedSymbols.delete(coin);

    if (this.isConnected && this.ws) {
      const msg = {
        method: 'unsubscribe',
        subscription: { type: 'l2Book', coin }
      };
      this.ws.send(JSON.stringify(msg));
      logger.debug(`[WsClient] Unsubscribed from ${coin}`);
    }

    this.bboCache.delete(coin);
  }

  /**
   * Get cached BBO for a symbol
   */
  getBbo(symbol: string): BboData | null {
    const coin = this.normalizeSymbol(symbol);
    return this.bboCache.get(coin) || null;
  }

  /**
   * Check if BBO data is stale
   */
  isStale(symbol: string, maxAgeMs?: number): boolean {
    const coin = this.normalizeSymbol(symbol);
    const bbo = this.bboCache.get(coin);
    if (!bbo) return true;
    
    const age = Date.now() - bbo.ts;
    return age > (maxAgeMs || this.config.staleMs);
  }

  /**
   * Check if connected
   */
  isConnectedAndHealthy(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection status
   */
  getStatus(): { connected: boolean; lastError: string | null; subscribedSymbols: string[] } {
    return {
      connected: this.isConnected,
      lastError: this.lastError,
      subscribedSymbols: Array.from(this.subscribedSymbols),
    };
  }

  // ========================================
  // PRIVATE METHODS
  // ========================================

  private normalizeSymbol(symbol: string): string {
    // Convert BTC-USDC -> BTC, ETH-USDC -> ETH, etc.
    return symbol.replace(/-USDC|-USD|-PERP/i, '').toUpperCase();
  }

  private denormalizeSymbol(coin: string): string {
    // Convert BTC -> BTC-USDC for internal use
    return `${coin}-USDC`;
  }

  private handleOpen(): void {
    logger.info('[WsClient] Connected');
    this.isConnected = true;
    this.reconnectAttempt = 0;
    this.lastError = null;
    
    // Re-subscribe to all symbols
    for (const coin of this.subscribedSymbols) {
      this.sendSubscription(coin);
    }

    // Start ping interval to keep connection alive
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);

    this.emit('status', { connected: true });
  }

  private sendSubscription(coin: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Hyperliquid WS subscription format for L2 book (depth 1 for BBO)
    const msg = {
      method: 'subscribe',
      subscription: { type: 'l2Book', coin }
    };
    
    this.ws.send(JSON.stringify(msg));
    logger.debug(`[WsClient] Subscribed to l2Book for ${coin}`);
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(data.toString());
      
      // Handle l2Book updates
      if (parsed.channel === 'l2Book' && parsed.data) {
        this.processL2BookUpdate(parsed.data);
      }
    } catch (err) {
      logger.debug('[WsClient] Failed to parse message', { error: String(err) });
    }
  }

  private processL2BookUpdate(bookData: any): void {
    try {
      const coin = bookData.coin;
      if (!coin) return;

      const levels = bookData.levels;
      if (!levels || !Array.isArray(levels) || levels.length < 2) return;

      const bids = levels[0];
      const asks = levels[1];

      if (!bids?.length || !asks?.length) return;

      // Extract BBO from top of book
      const bestBid = parseFloat(bids[0].px);
      const bestAsk = parseFloat(asks[0].px);
      const mid = (bestBid + bestAsk) / 2;
      const ts = Date.now();

      const bbo: BboData = { bestBid, bestAsk, mid, ts };
      this.bboCache.set(coin, bbo);

      // Emit event with denormalized symbol
      const symbol = this.denormalizeSymbol(coin);
      this.emit('bbo', symbol, bbo);
      
      logger.debug(`[WsClient] BBO update: ${coin} bid=${bestBid} ask=${bestAsk} mid=${mid.toFixed(2)}`);
    } catch (err) {
      logger.debug('[WsClient] Failed to process L2 book update', { error: String(err) });
    }
  }

  private handleError(err: Error): void {
    logger.error('[WsClient] WebSocket error', { error: err.message });
    this.lastError = err.message;
    this.emit('status', { connected: false, lastError: err.message });
  }

  private handleClose(code: number, reason: string): void {
    logger.warn(`[WsClient] Connection closed: ${code} - ${reason}`);
    this.isConnected = false;
    
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.emit('status', { connected: false, reason: `closed: ${code}` });
    
    // Auto-reconnect unless deliberately closed
    if (code !== 1000) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    // Exponential backoff with max delay
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.config.reconnectMaxDelayMs
    );
    
    this.reconnectAttempt++;
    logger.info(`[WsClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// ========================================
// SINGLETON EXPORT
// ========================================

export const hyperliquidWsClient = new HyperliquidWsClient();
export default hyperliquidWsClient;
