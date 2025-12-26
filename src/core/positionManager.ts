import { logger } from './logger';
import dbService from '../database/dbService';
import { hyperliquidService } from '../services/hyperliquidService';
import { config } from '../utils/config';
import { orderBookAnalyzer } from '../services/orderBookAnalyzer';
import { liquidityTracker } from '../services/liquidityTracker';
import { spikeAnalyzer } from '../services/spikeAnalyzer';
import { eventDrivenTradeLoop } from './eventDrivenTradeLoop';

/**
 * Position Manager - ELITE SCALPER LOGIC v3.0
 * 
 * FILOSOFIA: "Cut losers fast, let winners run, EXIT FAST on reversal"
 * - Stop loss AGGRESSIVO e DINAMICO basato su ATR
 * - Take profit con trailing per catturare i move grandi
 * - Smart exit basato su order flow reale
 * - RAPID EXIT su spoofing reversal signal
 */
class PositionManager {
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_FREQUENCY_MS = 500; // Check every 500ms (più reattivo per exit veloci)

  // ============================================
  // RISK MANAGEMENT - SCALPER ELITE v3.0
  // ============================================
  // REGOLA D'ORO: Risk/Reward MINIMO 1:3
  // "Cut losers FAST, let winners RUN, EXIT FAST on reversal"
  
  // STOP LOSS: PIÙ STRETTO per proteggere capitale su volatilità
  private readonly DEFAULT_STOP_LOSS_PERCENT = 1.5;        // 1.5% SL (taglia perdite velocissimo)
  
  // TAKE PROFIT: Ragionevole per scalping
  private readonly DEFAULT_TAKE_PROFIT_PERCENT = 6.0;      // 6% TP (4:1 R:R)
  
  // TRAILING STOP: Più stretto per bloccare profitti prima
  private readonly TRAILING_STOP_ACTIVATION_PERCENT = 2.0; // Attiva dopo 2% profit
  private readonly TRAILING_STOP_DISTANCE_PERCENT = 1.0;   // Trail a 1% (aggressivo)
  
  // TIME MANAGEMENT - PIÙ CORTO per scalping
  private readonly MAX_POSITION_AGE_MINUTES = 30;          // 30 min max per trade

  // SMART EXIT PARAMETERS - PIÙ SENSIBILI per exit rapido
  private readonly SMART_EXIT_MIN_PROFIT_PERCENT = 1.5;    // Min 1.5% profit per smart exit
  private readonly REVERSAL_IMBALANCE_THRESHOLD = 0.40;    // 40% imbalance = exit (più sensibile)
  private readonly MOMENTUM_REVERSAL_THRESHOLD = -0.25;    // Momentum shift minore
  private readonly PRESSURE_REVERSAL_THRESHOLD = 0.35;     // Pressure delta ridotto
  
  // SPOOFING REVERSAL EXIT - Nuovo parametro
  private readonly SPOOFING_EXIT_MIN_DOMINANCE = 0.65;     // 65% spoofing dominanza contraria = exit

  // WALL BROKEN EXIT - Exit quando il muro di spoofing sparisce
  private readonly WALL_BROKEN_MIN_PROFIT_PERCENT = 0.3;   // Min 0.3% profit per wall broken exit
  private readonly WALL_BROKEN_SPIKE_RELAX_THRESHOLD = 50; // Compression > 50% = rilassamento
  private readonly WALL_BROKEN_VOLATILITY_THRESHOLD = 0.03; // Volatilità < 3% = stabilizzazione

  // Track wall states per position (per rilevare rottura)
  private wallStates: Map<string, { 
    lastSpoofingCount: number; 
    lastSpoofingSide: 'ASK' | 'BID' | null;
    entryPrice: number;
    peakPrice: number;
    wallBroken: boolean;
    wallBrokenTimestamp: number;
  }> = new Map();

  // Track trailing stop prices per position
  private trailingStops: Map<string, { highestPrice: number; lowestPrice: number }> = new Map();

  // Track momentum history per position for reversal detection
  private positionMomentum: Map<string, { imbalanceHistory: number[]; priceHistory: number[] }> = new Map();

  // Prevent concurrent position checks (race condition protection)
  private isChecking = false;

  // Track trades currently being closed to prevent duplicate closes
  private closingTrades: Set<string> = new Set();

  /**
   * Starts the position monitoring loop
   */
  start(): void {
    if (this.checkInterval) {
      logger.warn('Position manager already running');
      return;
    }

    logger.info('🛡️ Starting Position Manager', {
      stopLossPercent: this.DEFAULT_STOP_LOSS_PERCENT,
      takeProfitPercent: this.DEFAULT_TAKE_PROFIT_PERCENT,
      trailingStopActivation: this.TRAILING_STOP_ACTIVATION_PERCENT,
      trailingStopDistance: this.TRAILING_STOP_DISTANCE_PERCENT,
      maxPositionAgeMinutes: this.MAX_POSITION_AGE_MINUTES,
    });

    this.checkInterval = setInterval(async () => {
      await this.checkAllPositions();
    }, this.CHECK_FREQUENCY_MS);

    // Run immediately
    this.checkAllPositions();
  }

  /**
   * Stops the position monitoring loop
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('⏹️ Position Manager stopped');
    }
    // Clear closing trades set on stop
    this.closingTrades.clear();
  }

  /**
   * Checks all open positions for SL/TP/Trailing Stop/Time-based exit
   */
  private async checkAllPositions(): Promise<void> {
    // Prevent concurrent checks (race condition protection)
    if (this.isChecking) {
      return;
    }
    this.isChecking = true;

    try {
      const positions = await dbService.getActiveTrades();

      if (positions.length === 0) {
        this.isChecking = false;
        return;
      }

      for (const position of positions) {
        // Skip if this trade is already being closed
        if (this.closingTrades.has(position.trade_id)) {
          continue;
        }
        await this.checkPosition(position);
      }
    } catch (error) {
      logger.error('Error checking positions', error);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Checks a single position for exit conditions
   */
  private async checkPosition(position: any): Promise<void> {
    try {
      const symbol = position.symbol;
      const entryPrice = parseFloat(position.entry_price);
      const side = position.side; // 'buy' or 'sell'
      const leverage = parseFloat(position.leverage || 1);
      const tradeId = position.trade_id;
      const executedAt = new Date(position.executed_at);

      // Get current price
      const currentPrice = await hyperliquidService.getTickerPrice(symbol);

      // Calculate P&L percentage
      let pnlPercent: number;
      if (side === 'buy') {
        pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * leverage;
      } else {
        pnlPercent = ((entryPrice - currentPrice) / entryPrice) * 100 * leverage;
      }

      // Get or initialize trailing stop data
      let trailingData = this.trailingStops.get(tradeId);
      if (!trailingData) {
        trailingData = { highestPrice: currentPrice, lowestPrice: currentPrice };
        this.trailingStops.set(tradeId, trailingData);
      }

      // Update highest/lowest price for trailing stop
      if (side === 'buy') {
        if (currentPrice > trailingData.highestPrice) {
          trailingData.highestPrice = currentPrice;
          this.trailingStops.set(tradeId, trailingData);
        }
      } else {
        if (currentPrice < trailingData.lowestPrice) {
          trailingData.lowestPrice = currentPrice;
          this.trailingStops.set(tradeId, trailingData);
        }
      }

      // Check exit conditions in priority order
      let shouldClose = false;
      let closeReason = '';

      // 1. Check STOP LOSS
      if (pnlPercent <= -this.DEFAULT_STOP_LOSS_PERCENT) {
        shouldClose = true;
        closeReason = `🛑 STOP LOSS HIT (${pnlPercent.toFixed(2)}% loss)`;
      }

      // 2. Check TAKE PROFIT
      if (!shouldClose && pnlPercent >= this.DEFAULT_TAKE_PROFIT_PERCENT) {
        shouldClose = true;
        closeReason = `🎯 TAKE PROFIT HIT (${pnlPercent.toFixed(2)}% profit)`;
      }

      // 3. Check TRAILING STOP (only if in profit)
      if (!shouldClose && pnlPercent >= this.TRAILING_STOP_ACTIVATION_PERCENT) {
        let trailingStopTriggered = false;

        if (side === 'buy') {
          const trailingStopPrice = trailingData.highestPrice * (1 - this.TRAILING_STOP_DISTANCE_PERCENT / 100);
          if (currentPrice <= trailingStopPrice) {
            trailingStopTriggered = true;
          }
        } else {
          const trailingStopPrice = trailingData.lowestPrice * (1 + this.TRAILING_STOP_DISTANCE_PERCENT / 100);
          if (currentPrice >= trailingStopPrice) {
            trailingStopTriggered = true;
          }
        }

        if (trailingStopTriggered) {
          shouldClose = true;
          closeReason = `📉 TRAILING STOP HIT (locked ${pnlPercent.toFixed(2)}% profit)`;
        }
      }

      // 4. SMART EXIT - Professional Scalper Logic (replaces simple time-based exit)
      // Only for positions in profit - detect reversal patterns
      if (!shouldClose && pnlPercent >= this.SMART_EXIT_MIN_PROFIT_PERCENT) {
        const smartExitSignal = await this.checkSmartExit(symbol, side, pnlPercent, tradeId);
        if (smartExitSignal.shouldExit) {
          shouldClose = true;
          closeReason = smartExitSignal.reason;
        }
      }

      // 4.5. SPOOFING REVERSAL EXIT - Exit if spoofing signal flips against position
      // This catches market manipulation reversals quickly
      if (!shouldClose && pnlPercent > -0.5) {  // Allow for small loss to avoid bigger loss
        const spoofingExit = this.checkSpoofingReversalExit(side, pnlPercent);
        if (spoofingExit.shouldExit) {
          shouldClose = true;
          closeReason = spoofingExit.reason;
        }
      }

      // 4.6. WALL BROKEN + SPIKE RELAXATION EXIT
      // Chiude quando il muro sparisce E lo spike si riassorbe (in profitto)
      if (!shouldClose && pnlPercent >= this.WALL_BROKEN_MIN_PROFIT_PERCENT) {
        const wallBrokenExit = this.checkWallBrokenSpikeRelaxExit(tradeId, side, currentPrice, entryPrice, pnlPercent);
        if (wallBrokenExit.shouldExit) {
          shouldClose = true;
          closeReason = wallBrokenExit.reason;
        }
      }

      // 5. TIME-BASED EXIT - Only as LAST RESORT fallback
      if (!shouldClose) {
        const positionAgeMinutes = (Date.now() - executedAt.getTime()) / (1000 * 60);
        if (positionAgeMinutes >= this.MAX_POSITION_AGE_MINUTES) {
          shouldClose = true;
          closeReason = `⏰ FALLBACK TIME EXIT (${positionAgeMinutes.toFixed(0)} min, P&L: ${pnlPercent.toFixed(2)}%)`;
        }
      }

      // Close position if any condition triggered
      if (shouldClose) {
        await this.closePosition(position, currentPrice, closeReason);
      }

    } catch (error) {
      logger.error(`Error checking position ${position.trade_id}`, error);
    }
  }

  /**
   * CHECK SPOOFING REVERSAL - Exit if spoofing flips against position
   */
  private checkSpoofingReversalExit(
    side: 'buy' | 'sell',
    currentPnlPercent: number
  ): { shouldExit: boolean; reason: string } {
    try {
      const spoofSignal = liquidityTracker.getAntiSpoofingSignal();
      
      // Check if spoofing is strongly signaling opposite direction
      if (spoofSignal.action === 'WAIT' || spoofSignal.confidence < 60) {
        return { shouldExit: false, reason: '' };
      }
      
      // BUY position and spoofing says SELL (BID spoofing = distribution)
      // SELL position and spoofing says BUY (ASK spoofing = accumulation)
      const isOpposite = (side === 'buy' && spoofSignal.action === 'SELL') ||
                         (side === 'sell' && spoofSignal.action === 'BUY');
      
      if (isOpposite && spoofSignal.details.spoofRatio >= this.SPOOFING_EXIT_MIN_DOMINANCE) {
        const pnlEmoji = currentPnlPercent >= 0 ? '🟢' : '🔴';
        return {
          shouldExit: true,
          reason: `🎯 SPOOFING REVERSAL EXIT: ${spoofSignal.action} signal (${(spoofSignal.details.spoofRatio * 100).toFixed(0)}% dominance) ${pnlEmoji} P&L: ${currentPnlPercent.toFixed(2)}%`
        };
      }
      
      return { shouldExit: false, reason: '' };
    } catch {
      logger.debug('Spoofing reversal check failed');
      return { shouldExit: false, reason: '' };
    }
  }

  /**
   * WALL BROKEN + SPIKE RELAXATION EXIT
   * Chiude la posizione quando:
   * 1. Il muro di spoofing scompare (ordini rimossi)
   * 2. Il prezzo inizia a scendere/stabilizzarsi (rilassamento spike)
   * 3. La posizione è in profitto
   * 
   * Logica: Dopo uno spike causato da spoofing, quando il muro viene "rotto" 
   * (ordini rimossi), il prezzo tende a ritracciare. Catturiamo il profitto 
   * appena notiamo il rilassamento.
   */
  private checkWallBrokenSpikeRelaxExit(
    tradeId: string,
    side: 'buy' | 'sell',
    currentPrice: number,
    entryPrice: number,
    currentPnlPercent: number
  ): { shouldExit: boolean; reason: string } {
    try {
      // Get current spoofing state
      const spoofSignal = liquidityTracker.getAntiSpoofingSignal();
      const spikeData = spikeAnalyzer.getAnalysisData();
      
      // Initialize or get wall state for this position
      let wallState = this.wallStates.get(tradeId);
      if (!wallState) {
        wallState = {
          lastSpoofingCount: spoofSignal.details.highConfidenceAlerts,
          lastSpoofingSide: spoofSignal.details.askSpoofCount > spoofSignal.details.bidSpoofCount ? 'ASK' : 
                           spoofSignal.details.bidSpoofCount > spoofSignal.details.askSpoofCount ? 'BID' : null,
          entryPrice,
          peakPrice: currentPrice,
          wallBroken: false,
          wallBrokenTimestamp: 0,
        };
        this.wallStates.set(tradeId, wallState);
        return { shouldExit: false, reason: '' };
      }
      
      // Update peak price tracking
      if (side === 'buy' && currentPrice > wallState.peakPrice) {
        wallState.peakPrice = currentPrice;
      } else if (side === 'sell' && currentPrice < wallState.peakPrice) {
        wallState.peakPrice = currentPrice;
      }
      
      // Check for WALL BROKEN
      // Il muro è rotto quando gli spoofing alerts diminuiscono significativamente
      const currentSpoofCount = spoofSignal.details.highConfidenceAlerts;
      const spoofingDropped = wallState.lastSpoofingCount >= 3 && currentSpoofCount <= 1;
      
      // Oppure quando la dominanza spoofing scende drasticamente
      const dominanceCollapsed = wallState.lastSpoofingCount >= 3 && spoofSignal.confidence < 40;
      
      if (!wallState.wallBroken && (spoofingDropped || dominanceCollapsed)) {
        wallState.wallBroken = true;
        wallState.wallBrokenTimestamp = Date.now();
        
        logger.info(`🧱💥 [${tradeId}] WALL BROKEN DETECTED!`, {
          previousSpoofCount: wallState.lastSpoofingCount,
          currentSpoofCount,
          dominanceCollapsed,
          currentPnlPercent,
          side,
        });
      }
      
      // Update last spoofing count
      wallState.lastSpoofingCount = currentSpoofCount;
      this.wallStates.set(tradeId, wallState);
      
      // Se il muro non è ancora rotto, non fare nulla
      if (!wallState.wallBroken) {
        return { shouldExit: false, reason: '' };
      }
      
      // Il muro è rotto - ora cerchiamo segni di SPIKE RELAXATION
      const timeSinceWallBroken = Date.now() - wallState.wallBrokenTimestamp;
      
      // Check spike relaxation conditions
      const behavior = spikeData?.currentBehavior;
      const compressionHigh = behavior && behavior.compressionLevel >= this.WALL_BROKEN_SPIKE_RELAX_THRESHOLD;
      const volatilityLow = behavior && behavior.volatility <= this.WALL_BROKEN_VOLATILITY_THRESHOLD;
      
      // Check price retracement from peak
      let priceRetracementPercent = 0;
      if (side === 'buy') {
        // Per long: ritracciamento = quanto è sceso dal picco
        priceRetracementPercent = ((wallState.peakPrice - currentPrice) / wallState.peakPrice) * 100;
      } else {
        // Per short: ritracciamento = quanto è salito dal minimo
        priceRetracementPercent = ((currentPrice - wallState.peakPrice) / wallState.peakPrice) * 100;
      }
      
      // Rilassamento confermato se:
      // 1. Prezzo sta ritracciando (scende per long, sale per short)
      // 2. Volatilità si sta calmando
      // 3. Sono passati almeno 2 secondi dal wall broken (evita falsi positivi)
      const priceRetracing = priceRetracementPercent > 0.05; // >0.05% ritracciamento
      const relaxationConfirmed = priceRetracing && (compressionHigh || volatilityLow);
      const minTimeElapsed = timeSinceWallBroken >= 2000; // Almeno 2 secondi
      
      if (relaxationConfirmed && minTimeElapsed && currentPnlPercent >= this.WALL_BROKEN_MIN_PROFIT_PERCENT) {
        // Cleanup wall state
        this.wallStates.delete(tradeId);
        
        logger.info(`🧱📉 [${tradeId}] SPIKE RELAXATION EXIT triggered`, {
          priceRetracementPercent,
          compressionLevel: behavior?.compressionLevel,
          volatility: behavior?.volatility,
          timeSinceWallBroken,
          currentPnlPercent,
        });
        
        return {
          shouldExit: true,
          reason: `🧱📉 WALL BROKEN + SPIKE RELAX: Muro rotto e prezzo in rilassamento ` +
                  `(ritracciamento: ${priceRetracementPercent.toFixed(2)}%, ` +
                  `compression: ${(behavior?.compressionLevel || 0).toFixed(0)}%) ` +
                  `✅ Locked ${currentPnlPercent.toFixed(2)}% profit`
        };
      }
      
      // Fallback: se il muro è rotto da più di 10 secondi e siamo in profitto decente
      // chiudi comunque per evitare di perdere i guadagni
      if (wallState.wallBroken && timeSinceWallBroken >= 10000 && currentPnlPercent >= 1.0) {
        this.wallStates.delete(tradeId);
        
        return {
          shouldExit: true,
          reason: `🧱⏱️ WALL BROKEN TIMEOUT: Muro rotto da ${(timeSinceWallBroken/1000).toFixed(0)}s, ` +
                  `chiusura preventiva ✅ Locked ${currentPnlPercent.toFixed(2)}% profit`
        };
      }
      
      return { shouldExit: false, reason: '' };
      
    } catch {
      logger.debug('Wall broken spike relax check failed');
      return { shouldExit: false, reason: '' };
    }
  }

  /**
   * SMART EXIT - Professional Scalper Reversal Detection
   * Analyzes order book in real-time to detect reversal patterns
   * Only called for positions that are already in profit
   */
  private async checkSmartExit(
    symbol: string,
    side: 'buy' | 'sell',
    currentPnlPercent: number,
    tradeId: string
  ): Promise<{ shouldExit: boolean; reason: string }> {
    try {
      // Get current order book analysis
      const orderBook = await orderBookAnalyzer.analyzeOrderBook(symbol);

      if (!orderBook) {
        return { shouldExit: false, reason: '' };
      }

      // Get or initialize momentum history for this position
      let momentum = this.positionMomentum.get(tradeId);
      if (!momentum) {
        momentum = { imbalanceHistory: [], priceHistory: [] };
        this.positionMomentum.set(tradeId, momentum);
      }

      // Track imbalance history
      momentum.imbalanceHistory.push(orderBook.imbalanceRatio);
      if (momentum.imbalanceHistory.length > 5) {
        momentum.imbalanceHistory.shift();
      }

      // ===== REVERSAL DETECTION PATTERNS =====

      // 1. IMBALANCE REVERSAL: Order book flipped against our position
      const imbalanceAgainstUs = (side === 'buy' && orderBook.imbalanceRatio < -this.REVERSAL_IMBALANCE_THRESHOLD) ||
        (side === 'sell' && orderBook.imbalanceRatio > this.REVERSAL_IMBALANCE_THRESHOLD);

      if (imbalanceAgainstUs) {
        logger.info(`🔄 [${symbol}] IMBALANCE REVERSAL detected for ${side.toUpperCase()}`, {
          imbalancePercent: orderBook.imbalanceRatio * 100,
          pnlPercent: currentPnlPercent
        });
        return {
          shouldExit: true,
          reason: `🔄 SMART EXIT: Imbalance reversal (${(orderBook.imbalanceRatio * 100).toFixed(1)}% against position, locked ${currentPnlPercent.toFixed(2)}% profit)`
        };
      }

      // 2. PRESSURE DELTA REVERSAL: Buying/selling pressure shifted
      const pressureAgainstUs = (side === 'buy' && orderBook.pressureDelta < -this.PRESSURE_REVERSAL_THRESHOLD) ||
        (side === 'sell' && orderBook.pressureDelta > this.PRESSURE_REVERSAL_THRESHOLD);

      if (pressureAgainstUs) {
        logger.info(`📊 [${symbol}] PRESSURE REVERSAL detected for ${side.toUpperCase()}`, {
          pressureDeltaPercent: orderBook.pressureDelta * 100,
          pnlPercent: currentPnlPercent
        });
        return {
          shouldExit: true,
          reason: `📊 SMART EXIT: Pressure reversal (${(orderBook.pressureDelta * 100).toFixed(1)}% against position, locked ${currentPnlPercent.toFixed(2)}% profit)`
        };
      }

      // 3. ABSORPTION DETECTED: Big orders absorbed without follow-through (reversal signal)
      if (orderBook.absorptionDetected) {
        logger.info(`🧱 [${symbol}] ABSORPTION detected - potential reversal`, {
          marketState: orderBook.marketState,
          pnlPercent: currentPnlPercent
        });
        return {
          shouldExit: true,
          reason: `🧱 SMART EXIT: Absorption detected (locked ${currentPnlPercent.toFixed(2)}% profit before reversal)`
        };
      }

      // 4. MOMENTUM DETERIORATION: Imbalance getting worse over time
      if (momentum.imbalanceHistory.length >= 3) {
        const recentImbalances = momentum.imbalanceHistory.slice(-3);
        const avgRecent = recentImbalances.reduce((a, b) => a + b, 0) / recentImbalances.length;
        const oldImbalances = momentum.imbalanceHistory.slice(0, -3);
        const avgOld = oldImbalances.length > 0
          ? oldImbalances.reduce((a, b) => a + b, 0) / oldImbalances.length
          : avgRecent;

        const momentumShift = avgRecent - avgOld;

        // Momentum turning against us
        const momentumAgainstUs = (side === 'buy' && momentumShift < this.MOMENTUM_REVERSAL_THRESHOLD) ||
          (side === 'sell' && momentumShift > -this.MOMENTUM_REVERSAL_THRESHOLD && momentumShift > 0);

        if (momentumAgainstUs && currentPnlPercent >= 1.5) { // Solo se profitto decente
          logger.info(`📉 [${symbol}] MOMENTUM SHIFT detected for ${side.toUpperCase()}`, {
            momentumShiftPercent: momentumShift * 100,
            pnlPercent: currentPnlPercent
          });
          return {
            shouldExit: true,
            reason: `📉 SMART EXIT: Momentum shift (${(momentumShift * 100).toFixed(2)}% deterioration, locked ${currentPnlPercent.toFixed(2)}% profit)`
          };
        }
      }

      // 5. MARKET STATE CHANGE: From trend to consolidation (take profits)
      if (orderBook.marketState === 'CONSOLIDATION' && currentPnlPercent >= 2.0) {
        logger.info(`⚖️ [${symbol}] Market entering CONSOLIDATION - taking profits`, {
          pnlPercent: currentPnlPercent
        });
        return {
          shouldExit: true,
          reason: `⚖️ SMART EXIT: Market consolidating (locked ${currentPnlPercent.toFixed(2)}% profit)`
        };
      }

      // No reversal signal detected - keep position open
      return { shouldExit: false, reason: '' };

    } catch (error) {
      logger.error(`Error in checkSmartExit for ${symbol}`, error);
      return { shouldExit: false, reason: '' };
    }
  }

  /**
   * Closes a position
   */
  private async closePosition(position: any, exitPrice: number, reason: string): Promise<void> {
    const tradeId = position.trade_id;

    // CRITICAL: Prevent duplicate close attempts
    if (this.closingTrades.has(tradeId)) {
      logger.warn(`⚠️ Trade ${tradeId} already being closed, skipping`);
      return;
    }

    // Mark as closing BEFORE any async operations
    this.closingTrades.add(tradeId);

    const symbol = position.symbol;
    const side = position.side;
    const entryPrice = parseFloat(position.entry_price);
    const quantity = parseFloat(position.quantity);
    const leverage = parseFloat(position.leverage || 1);

    // REALISTIC SIMULATION: Apply slippage on exit (always against you)
    // During stop loss, market moves fast = higher slippage
    const isStopLoss = reason.includes('STOP LOSS');
    const baseSlippage = isStopLoss ? 0.0004 : 0.0002; // 0.04% on SL, 0.02% on TP
    const slippagePercent = baseSlippage + Math.random() * 0.0003; // +0.03% random
    const slippageDirection = side === 'buy' ? -1 : 1; // Closing buy = sell = price drops
    const actualExitPrice = exitPrice * (1 + slippageDirection * slippagePercent);

    // REALISTIC SIMULATION: Latency on close (higher during volatility/SL)
    if (config.system.dryRun) {
      const latency = isStopLoss ? 80 + Math.random() * 120 : 40 + Math.random() * 60;
      await new Promise(resolve => setTimeout(resolve, latency));

      logger.debug(`🕐 Close simulation: latency=${latency.toFixed(0)}ms, slippage=${(slippagePercent * 100).toFixed(4)}%`);
    }

    // Calculate P&L with ACTUAL exit price (after slippage)
    let pnl: number;
    if (side === 'buy') {
      pnl = (actualExitPrice - entryPrice) * quantity * leverage;
    } else {
      pnl = (entryPrice - actualExitPrice) * quantity * leverage;
    }

    // Apply fees (0.035% taker per side = 0.07% round trip on Hyperliquid Tier 0)
    const takerFeeRate = 0.00035; // 0.035%
    const fees = (entryPrice * quantity * takerFeeRate) + (actualExitPrice * quantity * takerFeeRate);
    pnl -= fees;

    logger.info(`🔒 CLOSING POSITION: ${reason}`, {
      symbol,
      side,
      entryPrice,
      requestedExitPrice: exitPrice,
      actualExitPrice: actualExitPrice.toFixed(4),
      slippagePercent: (slippagePercent * 100).toFixed(4) + '%',
      quantity,
      leverage,
      pnlBeforeFees: pnl + fees,
      fees,
      pnl,
    });

    try {
      // Close in database with ACTUAL exit price
      await dbService.closeTrade(tradeId, actualExitPrice, pnl);

      // Calculate fees (approximate for simulation, real for live)
      // Taker fee: 0.035% (entry) + 0.035% (exit) = 0.07% total
      const entryFee = quantity * entryPrice * 0.00035;
      const exitFee = quantity * actualExitPrice * 0.00035;
      const totalFees = entryFee + exitFee;

      // UPDATE BALANCE: This is the key to realistic fund tracking
      // Subtract fees from P&L
      await dbService.updateBalanceOnTradeClose(pnl, totalFees);

      // If not DRY_RUN, close on exchange
      if (!config.system.dryRun) {
        const closeSide = side === 'buy' ? 'sell' : 'buy';
        await hyperliquidService.placeOrder(symbol, closeSide, quantity, exitPrice);
      }

      // Remove trailing stop tracking
      this.trailingStops.delete(tradeId);
      
      // Remove wall state tracking
      this.wallStates.delete(tradeId);
      
      // Remove momentum history
      this.positionMomentum.delete(tradeId);

      // ★ CRITICAL: Remove position from eventDrivenTradeLoop's in-memory cache
      // This prevents ghost positions from appearing in the UI
      eventDrivenTradeLoop.removePositionFromCache(symbol);

      // Emit WebSocket event
      const webServer = (global as any).webServer;
      if (webServer && typeof webServer.emitPositionClosed === 'function') {
        webServer.emitPositionClosed({
          tradeId,
          symbol,
          side,
          entryPrice,
          exitPrice,
          pnl,
          reason,
          timestamp: Date.now(),
        });
      }

      logger.info(`✅ Position closed: ${symbol} ${side.toUpperCase()} | P&L: $${pnl.toFixed(4)} | Reason: ${reason}`);

    } catch (error) {
      logger.error(`Failed to close position ${tradeId}`, error);
    } finally {
      // Always remove from closing set to allow future attempts if needed
      // But with a small delay to prevent immediate re-attempts
      setTimeout(() => {
        this.closingTrades.delete(tradeId);
      }, 5000); // 5 second cooldown before allowing re-attempt
    }
  }

  /**
   * Gets current trailing stop info for a position
   */
  getTrailingStopInfo(tradeId: string): { highestPrice: number; lowestPrice: number } | undefined {
    return this.trailingStops.get(tradeId);
  }

  /**
   * Gets win rate statistics from database
   */
  async getWinRateStats(): Promise<{
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    averageWin: number;
    averageLoss: number;
    profitFactor: number;
  }> {
    try {
      const stats = await dbService.getTradeStats();
      return stats;
    } catch (error) {
      logger.error('Failed to get win rate stats', error);
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        averageWin: 0,
        averageLoss: 0,
        profitFactor: 0,
      };
    }
  }
}

// Export singleton instance
export const positionManager = new PositionManager();
export default positionManager;
