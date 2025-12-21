import express, { Request, Response, NextFunction } from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import dbService from '../database/dbService';
import hyperliquidService from '../services/hyperliquidService';
import { logger } from '../core/logger';
import { backtestEngine, BacktestConfig } from '../backtest/backtestEngine';

/**
 * Web server for monitoring dashboard
 */
export class WebServer {
  private app: express.Application;
  private server: any;
  private io: Server;
  private port: number;

  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
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
    // Dashboard principale
    this.app.get('/', async (_req: Request, res: Response) => {
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

    // API Endpoints
    this.app.get('/api/stats', async (_req: Request, res: Response) => {
      try {
        const stats = await dbService.getDashboardStats();
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

    // API: Reset only balance (keep trades history)
    this.app.post('/api/account/reset', async (_req: Request, res: Response) => {
      try {
        await dbService.resetBalance();
        const startingBalance = parseFloat(process.env.STARTING_BALANCE || '100');
        this.io.emit('balance:reset', { balance: startingBalance });
        logger.info('Balance reset via API', { startingBalance });
        res.json({ success: true, balance: startingBalance });
      } catch (error) {
        logger.error('Failed to reset balance', error);
        res.status(500).json({ error: 'Failed to reset balance' });
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

      socket.on('disconnect', () => {
        connectedClients--;
        logger.info('Client disconnected', { socketId: socket.id, totalClients: connectedClients });
      });
    });

    // Broadcast updates periodically - solo se ci sono client connessi
    setInterval(async () => {
      // Skip se nessun client connesso
      if (connectedClients === 0) return;
      
      try {
        const stats = await dbService.getDashboardStats();
        this.io.emit('stats:update', stats);

        // Emit posizioni con P&L live e calcolo margine
        const activeTrades = await dbService.getActiveTrades();
        
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
      } catch (error) {
        logger.error('Failed to broadcast stats update', error);
      }
    }, 5000); // Every 5 seconds - ottimizzato per performance browser
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

      // Start server
      this.server.listen(this.port, () => {
        logger.info(`Web server running on http://localhost:${this.port}`);
        console.log(`\n🌐 Dashboard disponibile su: http://localhost:${this.port}\n`);
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
    await dbService.disconnect();
    this.server.close();
    logger.info('Web server stopped');
  }
}

export default WebServer;
