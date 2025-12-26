import express, { Request, Response, NextFunction } from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import dbService from '../database/dbService';
import hyperliquidService from '../services/hyperliquidService';
import { logger } from '../core/logger';
import { backtestEngine, BacktestConfig } from '../backtest/backtestEngine';
import { liquidityTracker } from '../services/liquidityTracker';
import { spikeAnalyzer } from '../services/spikeAnalyzer';
import { spooferProfiler } from '../services/spooferProfiler';
import { multiSymbolTracker } from '../services/multiSymbolLiquidityTracker';
import { eventDrivenTradeLoop, TradeSignal, TradeExecution } from '../core/eventDrivenTradeLoop';
import { config } from '../utils/config';

/**
 * Pending order structure
 */
export interface PendingOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  limitPrice: number;
  quantity: number;
  confidence: number;
  reasoning: string;
  createdAt: number;
  status: 'pending' | 'filled' | 'cancelled';
  currentPrice?: number;
}

/**
 * Web server for monitoring dashboard
 */
export class WebServer {
  private app: express.Application;
  private server: any;
  private io: Server;
  private port: number;
  private statsInterval: NodeJS.Timeout | null = null;
  
  // Storage per ordini pending (in memoria)
  private static pendingOrders: Map<string, PendingOrder> = new Map();

  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();

    // Pulizia periodica degli ordini pending vecchi (ogni 5 minuti)
    setInterval(() => this.cleanupOldPendingOrders(), 5 * 60 * 1000);
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Set EJS as template engine
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(__dirname, '../../views'));

    // Static files
    this.app.use(express.static(path.join(__dirname, '../../public')));

    // Body parser
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Logging middleware
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug(`${req.method} ${req.url}`);
      next();
    });
  }

  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Redirect root to anti-spoofing dashboard
    this.app.get('/', (_req: Request, res: Response) => {
      res.redirect('/antispoof');
    });

    // Old dashboard (legacy)
    this.app.get('/dashboard', async (_req: Request, res: Response) => {
      try {
        const stats = await dbService.getDashboardStats();
        const activeTrades = await dbService.getActiveTrades();
        const recentDecisions = await dbService.getRecentDecisions(10);

        // Calcola P&L live per posizioni aperte
        for (const trade of activeTrades) {
          try {
            const currentPrice = await hyperliquidService.getTickerPrice(trade.symbol);
            const entryPrice = parseFloat(trade.entry_price) || 0;
            const quantity = parseFloat(trade.quantity) || 0;
            const entryFee = parseFloat(trade.fee) || 0;
            
            // P&L grezzo
            let grossPnl = 0;
            if (trade.side === 'buy') {
              grossPnl = (currentPrice - entryPrice) * quantity;
            } else {
              grossPnl = (entryPrice - currentPrice) * quantity;
            }
            
            // Stima exit fee (0.035% taker fee su Hyperliquid - Tier 0)
            const exitFeeRate = 0.00035; // 0.035%
            const exitValue = currentPrice * quantity;
            const estimatedExitFee = exitValue * exitFeeRate;
            
            // P&L netto = P&L grezzo - entry fee - exit fee stimata
            trade.unrealized_pnl = grossPnl - entryFee - estimatedExitFee;
            
            trade.current_price = currentPrice;
            trade.pnl_percentage = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : 0;
          } catch (error) {
            logger.error(`Error calculating P&L for ${trade.symbol}`, error);
            const entryPrice = parseFloat(trade.entry_price) || 0;
            trade.unrealized_pnl = 0;
            trade.current_price = entryPrice;
            trade.pnl_percentage = 0;
          }
        }

        res.render('dashboard', {
          title: 'Dashboard - Trading AI Agent',
          stats,
          activeTrades,
          recentDecisions,
        });
      } catch (error) {
        logger.error('Error loading dashboard', error);
        res.status(500).send('Errore nel caricamento della dashboard');
      }
    });

    // Pagina Trades
    this.app.get('/trades', async (_req: Request, res: Response) => {
      try {
        const trades = await dbService.getRecentTrades(100);
        const activeTrades = await dbService.getActiveTrades();

        res.render('trades', {
          title: 'Operazioni - Trading AI Agent',
          trades,
          activeTrades,
        });
      } catch (error) {
        logger.error('Error loading trades', error);
        res.status(500).send('Errore nel caricamento delle operazioni');
      }
    });

    // Pagina Performance
    this.app.get('/performance', async (_req: Request, res: Response) => {
      try {
        const metrics = await dbService.getPerformanceMetrics();
        const dailyPerformance = await dbService.getDailyPerformance(30);

        res.render('performance', {
          title: 'Performance - Trading AI Agent',
          metrics,
          dailyPerformance,
        });
      } catch (error) {
        logger.error('Error loading performance', error);
        res.status(500).send('Errore nel caricamento delle performance');
      }
    });

    // Pagina Decisioni AI
    this.app.get('/decisions', async (req: Request, res: Response) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;
        
        const allDecisions = await dbService.getRecentDecisions(1000);
        const totalDecisions = allDecisions.length;
        const totalPages = Math.ceil(totalDecisions / limit);
        const decisions = allDecisions.slice(offset, offset + limit);

        res.render('decisions', {
          title: 'Decisioni AI - Trading AI Agent',
          decisions,
          currentPage: page,
          totalPages,
          totalDecisions,
        });
      } catch (error) {
        logger.error('Error loading decisions', error);
        res.status(500).send('Errore nel caricamento delle decisioni');
      }
    });

    // Pagina Closed Trades (storico trade chiusi)
    this.app.get('/closed-trades', async (req: Request, res: Response) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const perPage = 50;
        const offset = (page - 1) * perPage;

        const symbol = req.query.symbol as string || '';
        const startDate = req.query.startDate as string || '';
        const endDate = req.query.endDate as string || '';
        const sortBy = req.query.sortBy as string || 'closed_at';
        const sortOrder = (req.query.sortOrder as 'ASC' | 'DESC') || 'DESC';

        const { trades, total } = await dbService.getAllClosedTrades({
          limit: perPage,
          offset,
          symbol: symbol || undefined,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          sortBy,
          sortOrder
        });

        const stats = await dbService.getClosedTradesStats();
        const symbolStats = await dbService.getClosedTradesBySymbol();
        const symbols = await dbService.getClosedTradesSymbols();
        const totalPages = Math.ceil(total / perPage);

        res.render('closed-trades', {
          title: 'Closed Trades - Trading AI Agent',
          trades,
          stats,
          symbolStats,
          symbols,
          total,
          currentPage: page,
          totalPages,
          perPage,
          currentFilters: { symbol, startDate, endDate, sortBy, sortOrder }
        });
      } catch (error) {
        logger.error('Error loading closed trades', error);
        res.status(500).send('Errore nel caricamento dello storico trade chiusi');
      }
    });

    // Pagina Liquidity Hunter
    this.app.get('/liquidity', async (_req: Request, res: Response) => {
      try {
        res.render('liquidity', {
          title: 'Liquidity Hunter - Trading AI Agent',
        });
      } catch (error) {
        logger.error('Error loading liquidity page', error);
        res.status(500).send('Errore nel caricamento della pagina liquidity');
      }
    });

    // Spike Analyzer Dashboard
    this.app.get('/spike', async (_req: Request, res: Response) => {
      try {
        res.render('spike', {
          title: 'Spike Analyzer - Trading AI Agent',
        });
      } catch (error) {
        logger.error('Error loading spike page', error);
        res.status(500).send('Errore nel caricamento della pagina spike');
      }
    });

    // Unified Analytics Dashboard
    this.app.get('/analytics', async (_req: Request, res: Response) => {
      try {
        res.render('analytics', {
          title: 'Trading Analytics - Unified Dashboard',
        });
      } catch (error) {
        logger.error('Error loading analytics page', error);
        res.status(500).send('Errore nel caricamento della pagina analytics');
      }
    });

    // Anti-Spoofing Dashboard (NEW MAIN DASHBOARD)
    this.app.get('/antispoof', async (_req: Request, res: Response) => {
      try {
        res.render('antispoof', {
          title: 'Anti-Spoofing Trading Dashboard',
        });
      } catch (error) {
        logger.error('Error loading antispoof page', error);
        res.status(500).send('Errore nel caricamento della pagina anti-spoofing');
      }
    });

    // Multi-Symbol Dashboard (NEW)
    this.app.get('/multisymbol', async (_req: Request, res: Response) => {
      try {
        res.render('multisymbol', {
          title: 'Multi-Symbol Trading Dashboard',
          symbols: config.trading.symbols,
        });
      } catch (error) {
        logger.error('Error loading multisymbol page', error);
        res.status(500).send('Errore nel caricamento della pagina multi-symbol');
      }
    });

    // API Endpoints
    this.app.get('/api/stats', async (_req: Request, res: Response) => {
      try {
        const stats = await dbService.getDashboardStats();
        
        // Add current price and live P&L to active trades
        if (stats.activeTrades && stats.activeTrades.length > 0) {
          // Get prices for all unique symbols
          const symbols = [...new Set(stats.activeTrades.map((t: any) => t.symbol))];
          const priceMap: Record<string, number> = {};
          
          for (const symbol of symbols) {
            try {
              priceMap[symbol as string] = await hyperliquidService.getTickerPrice(symbol as string);
            } catch (e) {
              priceMap[symbol as string] = 0;
            }
          }
          
          stats.activeTrades = stats.activeTrades.map((trade: any) => {
            const entryPrice = parseFloat(trade.entry_price) || 0;
            const quantity = parseFloat(trade.quantity) || 0;
            const leverage = parseInt(trade.leverage) || 20;
            const isLong = trade.side === 'buy';
            const currentPrice = priceMap[trade.symbol] || entryPrice;
            
            // Calculate live P&L
            const priceDiff = isLong ? (currentPrice - entryPrice) : (entryPrice - currentPrice);
            const livePnl = priceDiff * quantity * leverage;
            
            return {
              ...trade,
              currentPrice,
              livePnl
            };
          });
        }
        
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
      }
    });

    this.app.get('/api/trades', async (_req: Request, res: Response) => {
      try {
        const trades = await dbService.getRecentTrades(50);
        res.json(trades);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch trades' });
      }
    });

    // API: Get recent CLOSED trades for dashboard "Last Trades" section
    this.app.get('/api/trades/recent', async (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 10;
        const trades = await dbService.getRecentClosedTrades(limit);
        res.json(trades);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent trades' });
      }
    });

    this.app.get('/api/decisions', async (_req: Request, res: Response) => {
      try {
        const decisions = await dbService.getRecentDecisions(50);
        res.json(decisions);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch decisions' });
      }
    });

    this.app.get('/api/performance', async (_req: Request, res: Response) => {
      try {
        const metrics = await dbService.getPerformanceMetrics();
        res.json(metrics);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch performance' });
      }
    });

    // API: Liquidity snapshot
    this.app.get('/api/liquidity/snapshot', async (_req: Request, res: Response) => {
      try {
        const snapshot = liquidityTracker.getCurrentSnapshot();
        if (snapshot) {
          res.json(snapshot);
        } else {
          res.json({ error: 'No snapshot available', message: 'Liquidity tracker not started yet' });
        }
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch liquidity snapshot' });
      }
    });

    // API: Liquidity history
    this.app.get('/api/liquidity/history', async (_req: Request, res: Response) => {
      try {
        const history = liquidityTracker.getSnapshotHistory();
        res.json(history);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch liquidity history' });
      }
    });

    // API: Spoofing alerts
    this.app.get('/api/liquidity/spoofing', async (_req: Request, res: Response) => {
      try {
        const alerts = liquidityTracker.getSpoofingAlerts();
        res.json(alerts);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch spoofing alerts' });
      }
    });

    // API: Anti-Spoofing Signal - sfrutta lo spoofing per trading
    this.app.get('/api/liquidity/anti-spoofing', async (_req: Request, res: Response) => {
      try {
        const signal = liquidityTracker.getAntiSpoofingSignal();
        // Aggiungi prezzo corrente se manca
        const snapshot = liquidityTracker.getCurrentSnapshot();
        const currentPrice = snapshot?.currentPrice || 0;
        res.json({
          ...signal,
          details: {
            ...signal.details,
            currentPrice,
          }
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get anti-spoofing signal' });
      }
    });

    // ========================================
    // MULTI-SYMBOL API ENDPOINTS
    // ========================================

    // API: Get all configured symbols
    this.app.get('/api/symbols', async (_req: Request, res: Response) => {
      try {
        const symbols = config.trading.symbols;
        const status = multiSymbolTracker.getStatus();
        res.json({ symbols, status });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get symbols' });
      }
    });

    // API: Get snapshot for specific symbol
    this.app.get('/api/multisymbol/:symbol/snapshot', async (req: Request, res: Response) => {
      try {
        const { symbol } = req.params;
        const snapshot = multiSymbolTracker.getSnapshot(symbol);
        if (snapshot) {
          res.json(snapshot);
        } else {
          res.status(404).json({ error: `No data for ${symbol}` });
        }
      } catch (error) {
        res.status(500).json({ error: 'Failed to get snapshot' });
      }
    });

    // API: Get anti-spoofing signal for specific symbol
    this.app.get('/api/multisymbol/:symbol/signal', async (req: Request, res: Response) => {
      try {
        const { symbol } = req.params;
        const signal = multiSymbolTracker.getAntiSpoofingSignal(symbol);
        res.json(signal);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get signal' });
      }
    });

    // API: Get spoofing alerts for specific symbol
    this.app.get('/api/multisymbol/:symbol/alerts', async (req: Request, res: Response) => {
      try {
        const { symbol } = req.params;
        const alerts = multiSymbolTracker.getSpoofingAlerts(symbol);
        res.json(alerts);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get alerts' });
      }
    });

    // API: Get ALL symbols data at once
    this.app.get('/api/multisymbol/all', async (_req: Request, res: Response) => {
      try {
        const snapshots = multiSymbolTracker.getAllSnapshots();
        const signals = multiSymbolTracker.getAllSignals();
        const alerts = multiSymbolTracker.getAllSpoofingAlerts();
        res.json({ snapshots, signals, alerts });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get all data' });
      }
    });

    // API: Get ALL signals at once
    this.app.get('/api/multisymbol/signals', async (_req: Request, res: Response) => {
      try {
        const signals = multiSymbolTracker.getAllSignals();
        res.json(signals);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get signals' });
      }
    });

    // API: Spoofer Profiler - identificazione spoofer
    this.app.get('/api/spoofer/profiles', async (_req: Request, res: Response) => {
      try {
        const profiles = spooferProfiler.getAllProfiles();
        res.json(profiles);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get spoofer profiles' });
      }
    });

    // API: Active Spoofers
    this.app.get('/api/spoofer/active', async (_req: Request, res: Response) => {
      try {
        const active = spooferProfiler.getActiveSpoofers();
        res.json(active);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get active spoofers' });
      }
    });

    // API: Spoofer Stats
    this.app.get('/api/spoofer/stats', async (_req: Request, res: Response) => {
      try {
        const stats = spooferProfiler.getStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get spoofer stats' });
      }
    });

    // API: Spoofer-based Trading Signal
    this.app.get('/api/spoofer/signal', async (_req: Request, res: Response) => {
      try {
        const signal = spooferProfiler.getSpooferBasedSignal();
        res.json(signal);
      } catch (error) {
        res.status(500).json({ error: 'Failed to get spoofer signal' });
      }
    });

    // API: System orders
    this.app.get('/api/liquidity/orders', async (_req: Request, res: Response) => {
      try {
        const orders = liquidityTracker.getSystemOrders();
        res.json(orders);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch system orders' });
      }
    });

    // API: Surf recommendation
    this.app.get('/api/liquidity/surf', async (_req: Request, res: Response) => {
      try {
        const recommendation = liquidityTracker.getSurfRecommendation();
        res.json(recommendation);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch surf recommendation' });
      }
    });

    // API: Get/Set timeframe
    this.app.get('/api/liquidity/timeframe', async (_req: Request, res: Response) => {
      try {
        const timeframe = liquidityTracker.getTimeframe();
        res.json(timeframe);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch timeframe' });
      }
    });

    this.app.post('/api/liquidity/timeframe', async (req: Request, res: Response) => {
      try {
        const { timeframe } = req.body;
        if (!timeframe) {
          res.status(400).json({ error: 'Timeframe is required' });
          return;
        }
        liquidityTracker.setTimeframe(timeframe);
        const current = liquidityTracker.getTimeframe();
        this.io.emit('liquidity:timeframe', current);
        res.json({ success: true, ...current });
      } catch (error) {
        res.status(500).json({ error: 'Failed to set timeframe' });
      }
    });

    // ========================================
    // SPIKE ANALYZER API ENDPOINTS
    // ========================================
    
    // API: Spike analysis data
    this.app.get('/api/spike/analysis', async (_req: Request, res: Response) => {
      try {
        const data = spikeAnalyzer.getAnalysisData();
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch spike analysis' });
      }
    });

    // API: Price ticks for chart
    this.app.get('/api/spike/ticks', async (req: Request, res: Response) => {
      try {
        const minutes = parseInt(req.query.minutes as string) || 5;
        const ticks = spikeAnalyzer.getPriceTicks(minutes);
        res.json(ticks);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch price ticks' });
      }
    });

    // API: Current spike signal
    this.app.get('/api/spike/signal', async (_req: Request, res: Response) => {
      try {
        const signal = spikeAnalyzer.getCurrentSignal();
        const recommendation = spikeAnalyzer.getSpikeRecommendation();
        res.json({ signal, recommendation });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch spike signal' });
      }
    });

    // API: Chiudi una singola posizione
    this.app.post('/api/trades/:tradeId/close', async (req: Request, res: Response) => {
      try {
        const { tradeId } = req.params;
        
        // Recupera il trade
        const activeTrades = await dbService.getActiveTrades();
        const trade = activeTrades.find(t => t.trade_id === tradeId);
        
        if (!trade) {
          res.status(404).json({ error: 'Trade not found or already closed' });
          return;
        }
        
        // Ottieni prezzo corrente
        const currentPrice = await hyperliquidService.getTickerPrice(trade.symbol);
        const entryPrice = parseFloat(trade.entry_price) || 0;
        const quantity = parseFloat(trade.quantity) || 0;
        const leverage = parseFloat(trade.leverage) || 1;
        const entryFee = parseFloat(trade.fee) || 0;
        
        // Calcola P&L
        let grossPnl = 0;
        if (trade.side === 'buy') {
          grossPnl = (currentPrice - entryPrice) * quantity * leverage;
        } else {
          grossPnl = (entryPrice - currentPrice) * quantity * leverage;
        }
        
        // Exit fee (0.035% taker fee - Hyperliquid Tier 0)
        const exitFee = currentPrice * quantity * 0.00035;
        const netPnl = grossPnl - entryFee - exitFee;
        
        // Chiudi il trade nel database
        await dbService.closeTrade(tradeId, currentPrice, netPnl);
        
        // Update balance after trade close
        await dbService.updateBalanceOnTradeClose(netPnl);
        
        // Emetti aggiornamento via WebSocket
        this.io.emit('trade:closed', { tradeId, exitPrice: currentPrice, pnl: netPnl });
        
        logger.info('Trade closed via API', { tradeId, exitPrice: currentPrice, pnl: netPnl });
        res.json({ success: true, tradeId, exitPrice: currentPrice, pnl: netPnl });
      } catch (error) {
        logger.error('Failed to close trade', error);
        res.status(500).json({ error: 'Failed to close trade' });
      }
    });

    // API: Chiudi tutte le posizioni
    this.app.post('/api/trades/close-all', async (_req: Request, res: Response) => {
      try {
        const closedCount = await dbService.closeAllTrades();
        this.io.emit('trades:allClosed', { count: closedCount });
        logger.info('All trades closed via API', { count: closedCount });
        res.json({ success: true, closedCount });
      } catch (error) {
        logger.error('Failed to close all trades', error);
        res.status(500).json({ error: 'Failed to close all trades' });
      }
    });

    // API: Reset completo (per testing)
    this.app.post('/api/reset', async (_req: Request, res: Response) => {
      try {
        await dbService.resetAll();
        await dbService.resetBalance(); // Reset balance to STARTING_BALANCE
        await eventDrivenTradeLoop.reloadState();
        const startingBalance = parseFloat(process.env.STARTING_BALANCE || '100');
        this.io.emit('system:reset');
        logger.info('System reset via API', { startingBalance });
        res.json({ success: true, message: `System reset completed. Starting balance: $${startingBalance}` });
      } catch (error) {
        logger.error('Failed to reset system', error);
        res.status(500).json({ error: 'Failed to reset system' });
      }
    });

    // API: Get account state (balance, equity, margin)
    this.app.get('/api/account', async (_req: Request, res: Response) => {
      try {
        const accountState = await dbService.getAccountState();
        res.json(accountState);
      } catch (error) {
        logger.error('Failed to get account state', error);
        res.status(500).json({ error: 'Failed to get account state' });
      }
    });

    // API: Get pending orders
    this.app.get('/api/orders/pending', (_req: Request, res: Response) => {
      try {
        const pendingOrders = WebServer.getPendingOrders();
        res.json(pendingOrders);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending orders' });
      }
    });

    // API: Cancel pending order
    this.app.delete('/api/orders/pending/:orderId', (_req: Request, res: Response) => {
      try {
        const { orderId } = _req.params;
        WebServer.removePendingOrder(orderId);
        this.io.emit('pendingOrder:cancelled', { orderId });
        res.json({ success: true, orderId });
      } catch (error) {
        res.status(500).json({ error: 'Failed to cancel order' });
      }
    });

    // API: Reset only balance (keep trades history)
    this.app.post('/api/account/reset', async (_req: Request, res: Response) => {
      try {
        await dbService.resetBalance();
        await eventDrivenTradeLoop.reloadState();
        const startingBalance = parseFloat(process.env.STARTING_BALANCE || '100');
        this.io.emit('balance:reset', { balance: startingBalance });
        logger.info('Balance reset via API', { startingBalance });
        res.json({ success: true, balance: startingBalance });
      } catch (error) {
        logger.error('Failed to reset balance', error);
        res.status(500).json({ error: 'Failed to reset balance' });
      }
    });

    // API: Reset everything (balance + all data)
    this.app.post('/api/reset-all', async (_req: Request, res: Response) => {
      try {
        await dbService.resetAll();
        await eventDrivenTradeLoop.reloadState();
        const startingBalance = parseFloat(process.env.STARTING_BALANCE || '100');
        this.io.emit('balance:reset', { balance: startingBalance });
        logger.info('Complete reset via API', { startingBalance });
        res.json({ success: true, balance: startingBalance });
      } catch (error) {
        logger.error('Failed to reset all data', error);
        res.status(500).json({ error: 'Failed to reset all data' });
      }
    });

    // =====================================================
    // BACKTEST ENDPOINTS
    // =====================================================

    // Pagina Backtest
    this.app.get('/backtest', async (_req: Request, res: Response) => {
      try {
        res.render('backtest', {
          title: 'Backtest - Trading AI Agent',
        });
      } catch (error) {
        logger.error('Error loading backtest page', error);
        res.status(500).send('Errore nel caricamento della pagina backtest');
      }
    });

    // API: Avvia backtest
    this.app.post('/api/backtest/run', async (req: Request, res: Response) => {
      try {
        const {
          symbol = 'BTC',
          startDate,
          endDate,
          initialBalance = 100,
          leverage = 10,
          slPercent = 1,
          tpPercent = 2,
          useAI = false,
        } = req.body;

        const config: BacktestConfig = {
          symbol,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          initialBalance: parseFloat(initialBalance),
          leverage: parseInt(leverage),
          takerFee: 0.00035, // 0.035%
          slPercent: parseFloat(slPercent),
          tpPercent: parseFloat(tpPercent),
          useAI: useAI === true || useAI === 'true',
        };

        logger.info('Starting backtest via API', { symbol: config.symbol, useAI: config.useAI });

        // Setup real-time progress updates
        backtestEngine.on('progress', (data) => {
          this.io.emit('backtest:progress', data);
        });
        backtestEngine.on('status', (data) => {
          this.io.emit('backtest:status', data);
        });

        const result = await backtestEngine.runBacktest(config);

        // Cleanup listeners
        backtestEngine.removeAllListeners('progress');
        backtestEngine.removeAllListeners('status');

        this.io.emit('backtest:complete', result);
        res.json(result);
      } catch (error: any) {
        logger.error('Backtest failed', { error: error.message });
        res.status(500).json({ error: error.message || 'Backtest failed' });
      }
    });

    // API: Stop backtest
    this.app.post('/api/backtest/stop', (_req: Request, res: Response) => {
      try {
        backtestEngine.stop();
        res.json({ success: true, message: 'Backtest stopping...' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to stop backtest' });
      }
    });
  }

  /**
   * Setup Socket.IO for real-time updates
   */
  private setupSocketIO(): void {
    let connectedClients = 0;
    
    this.io.on('connection', (socket: any) => {
      connectedClients++;
      logger.info('Client connected to WebSocket', { socketId: socket.id, totalClients: connectedClients });

      // Send current state immediately on connection
      this.sendInitialState(socket);

      socket.on('disconnect', () => {
        connectedClients--;
        logger.info('Client disconnected', { socketId: socket.id, totalClients: connectedClients });
      });
    });

    // ========================================
    // EVENT-DRIVEN REAL-TIME UPDATES
    // ========================================
    
    // Signal updates (on every tick)
    eventDrivenTradeLoop.on('signal', (signal: TradeSignal) => {
      if (connectedClients > 0) {
        this.io.emit('signal:update', signal);
      }
    });

    // Trade executions (open/close)
    eventDrivenTradeLoop.on('trade', (execution: TradeExecution) => {
      if (connectedClients > 0) {
        this.io.emit('trade:execution', execution);
        logger.info(`[WebSocket] Trade execution emitted: ${execution.type} ${execution.side} ${execution.symbol}`);
      }
    });

    // Positions update (on every tick)
    eventDrivenTradeLoop.on('positions', (summary: any) => {
      if (connectedClients > 0) {
        this.io.emit('positions:realtime', summary);
      }
    });

    // Legacy: Broadcast stats periodically (for backward compatibility)
    this.statsInterval = setInterval(async () => {
      // Skip se nessun client connesso
      if (connectedClients === 0) return;
      
      try {
        const stats = await dbService.getDashboardStats();
        this.io.emit('stats:update', stats);

        // Emit posizioni con P&L live e calcolo margine
        let activeTrades = await dbService.getActiveTrades();

        // FILTER: Only keep trades that are known to EventDrivenTradeLoop
        // This prevents "ghost" positions that are closed in memory but not yet in DB
        // or if DB update failed. EventDrivenTradeLoop is the SOURCE OF TRUTH.
        const livePositions = eventDrivenTradeLoop.getPositionsSummary().positions;
        const liveTradeIds = new Set(livePositions.map(p => p.id));
        
        // Filter activeTrades to only include those present in EventDrivenTradeLoop
        activeTrades = activeTrades.filter(t => liveTradeIds.has(t.trade_id));
        
        // Get REAL persisted balance (not from .env)
        const currentBalance = await dbService.getCurrentBalance();
        let totalUnrealizedPnl = 0;
        let totalMarginUsed = 0;
        
        for (const trade of activeTrades) {
          try {
            const currentPrice = await hyperliquidService.getTickerPrice(trade.symbol);
            const entryPrice = parseFloat(trade.entry_price) || 0;
            const quantity = parseFloat(trade.quantity) || 0;
            const entryFee = parseFloat(trade.fee) || 0;
            const leverage = parseFloat(trade.leverage) || 1;
            
            // Calcolo margine utilizzato per questa posizione
            const positionValue = entryPrice * quantity;
            const marginUsed = positionValue / leverage;
            totalMarginUsed += marginUsed;
            
            // Calcolo P&L grezzo con leva
            let grossPnl = 0;
            if (trade.side === 'buy') {
              grossPnl = (currentPrice - entryPrice) * quantity * leverage;
            } else {
              grossPnl = (entryPrice - currentPrice) * quantity * leverage;
            }
            
            // Stima exit fee (0.035% taker fee su Hyperliquid - Tier 0)
            const exitFeeRate = 0.00035; // 0.035%
            const exitValue = currentPrice * quantity;
            const estimatedExitFee = exitValue * exitFeeRate;
            
            // P&L netto = P&L grezzo - entry fee - exit fee stimata
            trade.unrealized_pnl = grossPnl - entryFee - estimatedExitFee;
            totalUnrealizedPnl += trade.unrealized_pnl;
            
            trade.current_price = currentPrice;
            trade.pnl_percentage = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100 * leverage) : 0;
            trade.margin_used = marginUsed;
          } catch (error) {
            const entryPrice = parseFloat(trade.entry_price) || 0;
            trade.unrealized_pnl = 0;
            trade.current_price = entryPrice;
            trade.pnl_percentage = 0;
            trade.margin_used = 0;
          }
        }
        
        // Calcolo Balance, Equity e Margin disponibile (using REAL persisted balance)
        const equity = currentBalance + totalUnrealizedPnl;
        const freeMargin = equity - totalMarginUsed;
        const marginLevel = totalMarginUsed > 0 ? (equity / totalMarginUsed) * 100 : 0;
        
        this.io.emit('positions:update', {
          trades: activeTrades,
          balance: currentBalance,
          equity: equity,
          margin: totalMarginUsed,
          freeMargin: freeMargin,
          marginLevel: marginLevel,
          unrealizedPnl: totalUnrealizedPnl
        });

        // Emit recent AI decisions - ridotto a 5 per performance
        const recentDecisions = await dbService.getRecentDecisions(5);
        this.io.emit('decisions:update', recentDecisions);

        // Emit pending orders con prezzo aggiornato
        const pendingOrders = WebServer.getPendingOrders();
        for (const order of pendingOrders) {
          try {
            order.currentPrice = await hyperliquidService.getTickerPrice(order.symbol);
          } catch {
            // Keep previous price if fetch fails
          }
        }
        this.io.emit('pendingOrders:update', pendingOrders);

        // Emit liquidity data
        const liquiditySnapshot = liquidityTracker.getCurrentSnapshot();
        if (liquiditySnapshot) {
          this.io.emit('liquidity:snapshot', liquiditySnapshot);
          
          // Emit spoofing alerts
          const spoofingAlerts = liquidityTracker.getSpoofingAlerts();
          this.io.emit('liquidity:spoofing', spoofingAlerts);
          
          // Emit surf recommendation
          const surfRec = liquidityTracker.getSurfRecommendation();
          this.io.emit('liquidity:surf', surfRec);
          
          // Emit system orders
          const systemOrders = liquidityTracker.getSystemOrders();
          this.io.emit('liquidity:orders', systemOrders);
        }

        // Emit multi-symbol snapshots and signals
        const allSnapshots = multiSymbolTracker.getAllSnapshots();
        const allSignals = multiSymbolTracker.getAllSignals();
        this.io.emit('multisymbol:snapshots', allSnapshots);
        this.io.emit('multisymbol:signals', allSignals);

        // Emit account data
        const accountBalance = await dbService.getCurrentBalance();
        this.io.emit('account:update', { balance: accountBalance });

        // Emit recent trades
        const recentTrades = await dbService.getRecentClosedTrades(10);
        this.io.emit('trades:recent', recentTrades);
      } catch (error) {
        logger.error('Failed to broadcast stats update', error);
      }
    }, 1000); // Every 1 second - legacy updates
  }

  /**
   * Send initial state to a newly connected socket
   */
  private sendInitialState(socket: any): void {
    try {
      // Send current signals for all symbols
      const signals = eventDrivenTradeLoop.getCurrentSignals();
      for (const signal of Object.values(signals)) {
        socket.emit('signal:update', signal);
      }

      // Send current positions
      const positionsSummary = eventDrivenTradeLoop.getPositionsSummary();
      socket.emit('positions:realtime', positionsSummary);

      // Send all spoofing alerts for each symbol
      const allAlerts = multiSymbolTracker.getAllSpoofingAlerts();
      socket.emit('alerts:initial', allAlerts);

      logger.debug('Initial state sent to client', { socketId: socket.id });
    } catch (error) {
      logger.error('Failed to send initial state to client', error);
    }
  }

  /**
   * Add a pending order (static method for access from tradeLoop)
   */
  public static addPendingOrder(order: PendingOrder): void {
    WebServer.pendingOrders.set(order.id, order);
    logger.info('Pending order added', { id: order.id, symbol: order.symbol, side: order.side, limitPrice: order.limitPrice });
  }

  /**
   * Update pending order status
   */
  public static updatePendingOrder(orderId: string, updates: Partial<PendingOrder>): void {
    const order = WebServer.pendingOrders.get(orderId);
    if (order) {
      Object.assign(order, updates);
    }
  }

  /**
   * Remove pending order (when filled or cancelled)
   */
  public static removePendingOrder(orderId: string): void {
    WebServer.pendingOrders.delete(orderId);
    logger.info('Pending order removed', { id: orderId });
  }

  /**
   * Get all pending orders
   */
  public static getPendingOrders(): PendingOrder[] {
    return Array.from(WebServer.pendingOrders.values());
  }

  /**
   * Clear all pending orders
   */
  public static clearPendingOrders(): void {
    WebServer.pendingOrders.clear();
  }

  /**
   * Cleanup old pending orders (older than 10 minutes)
   */
  private cleanupOldPendingOrders(): void {
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000; // 10 minuti
    for (const [id, order] of WebServer.pendingOrders.entries()) {
      if (order.createdAt < cutoff) {
        WebServer.pendingOrders.delete(id);
        logger.debug(`Cleaned up old pending order: ${id}`);
      }
    }
  }

  /**
   * Emit new trade event
   */
  public emitNewTrade(trade: any): void {
    this.io.emit('trade:new', trade);
  }

  /**
   * Emit position closed event (by Position Manager)
   */
  public emitPositionClosed(data: {
    tradeId: string;
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    reason: string;
    timestamp: number;
  }): void {
    this.io.emit('position:closed', data);
    logger.info(`WebSocket: Position closed emitted`, { 
      symbol: data.symbol, 
      pnl: data.pnl,
      reason: data.reason 
    });
  }

  /**
   * Emit new decision event
   */
  public emitNewDecision(decision: any): void {
    this.io.emit('decision:new', decision);
  }

  /**
   * Emit market update event
   */
  public emitMarketUpdate(data: any): void {
    this.io.emit('market:update', data);
  }

  /**
   * Start the web server
   */
  public async start(): Promise<void> {
    try {
      // Connect to database first
      await dbService.connect();

      // Start server with promise wrapper to properly await
      await new Promise<void>((resolve, reject) => {
        this.server.listen(this.port, '0.0.0.0', () => {
          logger.info(`Web server running on http://localhost:${this.port}`);
          console.log(`\n🌐 Dashboard disponibile su: http://localhost:${this.port}\n`);
          resolve();
        });
        this.server.on('error', reject);
      });

      // Start EVENT-DRIVEN trade loop (in background to not block server)
      logger.info('Initializing EventDrivenTradeLoop...');
      eventDrivenTradeLoop.start()
        .then(() => {
          logger.info('🚀 Event-driven trade loop started (real-time trading)');
          
          // Start legacy services AFTER sync is complete to prevent network congestion
          liquidityTracker.start('BTC-USDC');
          logger.info('Liquidity tracker started for BTC-USDC');

          spikeAnalyzer.start('BTC-USDC');
          logger.info('Spike analyzer started for BTC-USDC');

          // Start multi-symbol tracker AFTER sync is complete
          multiSymbolTracker.startAll();
          logger.info(`Multi-symbol tracker started for: ${config.trading.symbols.join(', ')}`);
        })
        .catch((error) => {
          logger.error('Failed to start Event-driven trade loop', error);
        });
    } catch (error) {
      logger.error('Failed to start web server', error);
      throw error;
    }
  }

  /**
   * Stop the web server
   */
  public async stop(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    liquidityTracker.stop();
    multiSymbolTracker.stopAll();
    spikeAnalyzer.stop();
    eventDrivenTradeLoop.stop();
    await dbService.disconnect();
    this.server.close();
    logger.info('Web server stopped');
  }
}

export default WebServer;
