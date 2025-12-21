# 🤖 Trading AI Agent

> **Autonomous AI-driven cryptocurrency trading bot** powered by OpenAI/Claude for making intelligent trading decisions on Hyperliquid exchange.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Architecture](#-architecture)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Technical Indicators](#-technical-indicators)
- [AI Decision Engine](#-ai-decision-engine)
- [Backtesting](#-backtesting)
- [Risk Management](#-risk-management)
- [Logging & Monitoring](#-logging--monitoring)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🌟 Overview

**Trading AI Agent** is a sophisticated, production-ready trading bot that combines technical analysis with artificial intelligence to make autonomous trading decisions. The system continuously analyzes market data from Hyperliquid, computes technical indicators, and leverages AI models (GPT-4/Claude) to generate high-confidence trading signals.

### Key Highlights

- ✅ **AI-Powered Decisions**: Uses OpenAI GPT-4 or Anthropic Claude for intelligent trading analysis
- ✅ **Technical Analysis**: RSI, MACD, EMA, Bollinger Bands, ATR, and volume indicators
- ✅ **Real-time Trading**: Automated execution on Hyperliquid exchange
- ✅ **Backtesting Engine**: Simulate strategies on historical data
- ✅ **Risk Management**: Stop-loss, take-profit, position sizing, and daily limits
- ✅ **Dry Run Mode**: Test without risking real capital
- ✅ **Comprehensive Logging**: Winston-based structured logging with rotation
- ✅ **TypeScript**: Fully typed for reliability and maintainability

---

## 🚀 Features

### Core Functionality

| Feature | Description |
|---------|-------------|
| **Automated Trading** | Execute trades automatically based on AI decisions and technical signals |
| **Multi-Indicator Analysis** | RSI, MACD, EMA crossovers, Bollinger Bands, ATR, volume analysis |
| **AI Integration** | Support for OpenAI (GPT-4) and Anthropic (Claude) models |
| **Hyperliquid Integration** | Native support for Hyperliquid perpetual futures trading |
| **Scheduling** | Configurable intervals (1m, 5m, 15m, 1h, 4h, 1d) with cron-based scheduler |
| **Backtesting** | Test strategies on historical data with performance metrics |
| **Market Analysis** | Real-time market condition analysis and trend detection |
| **Decision Logging** | Every AI decision logged with reasoning and confidence scores |

### Risk Management

- **Position Sizing**: Configurable position size limits
- **Stop Loss**: Automatic stop-loss orders (2-3% default)
- **Take Profit**: Target profit levels (3-5% default)
- **Daily Limits**: Maximum trades and loss limits per day
- **Confidence Threshold**: Only execute trades above specified AI confidence (default 0.7)

### Safety Features

- **Dry Run Mode**: Simulate trades without execution
- **Live Trading Toggle**: Explicit flag required for real trading
- **Error Handling**: Comprehensive error handling with exponential backoff
- **Retry Logic**: Automatic retries for API failures
- **Graceful Shutdown**: Clean shutdown with statistics reporting

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Trading AI Agent                      │
└─────────────────────────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
    ┌────▼────┐      ┌─────▼─────┐     ┌─────▼─────┐
    │   CLI   │      │   Core    │     │ Services  │
    │ Commands│      │ TradeLoop │     │           │
    └─────────┘      └───────────┘     └───────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
    ┌────▼────┐      ┌─────▼─────┐     ┌─────▼─────┐
    │   AI    │      │Indicators │     │ Hyperliquid│
    │ Engine  │      │  Service  │     │  Service   │
    └─────────┘      └───────────┘     └────────────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                      ┌─────▼─────┐
                      │  Logger   │
                      └───────────┘
```

### Module Structure

```
trading-ai-agent/
├── src/
│   ├── core/               # Core trading loop and scheduler
│   │   ├── tradeLoop.ts    # Main trading orchestration
│   │   ├── scheduler.ts    # Task scheduling
│   │   └── logger.ts       # Winston logging configuration
│   ├── ai/                 # AI decision engine
│   │   ├── aiEngine.ts     # OpenAI/Claude integration
│   │   └── prompts/        # AI prompt templates
│   ├── services/           # External service integrations
│   │   ├── hyperliquidService.ts   # Exchange API client
│   │   └── marketDataService.ts    # Market data fetching
│   ├── strategies/         # Trading strategies
│   │   ├── indicators.ts   # Technical indicators
│   │   └── backtest.ts     # Backtesting engine
│   ├── utils/              # Utility functions
│   │   ├── config.ts       # Configuration management
│   │   ├── math.ts         # Mathematical utilities
│   │   └── constants.ts    # Application constants
│   ├── cli/                # CLI commands
│   │   └── commands.ts     # Command implementations
│   ├── types/              # TypeScript type definitions
│   │   └── index.d.ts      # All type definitions
│   └── index.ts            # Application entry point
```

---

## 💻 Installation

### Prerequisites

- **Node.js** 18+ 
- **npm** 9+
- **Hyperliquid API** credentials
- **OpenAI** or **Anthropic** API key

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/trading-ai-agent.git
cd trading-ai-agent

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env

# Build the project
npm run build

# Run tests
npm test

# Start trading (dry run mode by default)
npm run trade
```

---

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# Hyperliquid API Configuration
HYPERLIQUID_API_KEY=your_api_key_here
HYPERLIQUID_SECRET=your_secret_here
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz

# AI Model Configuration
AI_PROVIDER=openai                      # Options: openai, anthropic
OPENAI_API_KEY=sk-your-openai-key-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
AI_MODEL=gpt-4-turbo-preview            # or claude-3-5-sonnet-20241022

# Trading Configuration
BASE_SYMBOL=BTC-USD                     # Trading pair
TRADE_INTERVAL=1m                       # 1m, 5m, 15m, 1h, 4h, 1d
POSITION_SIZE=0.01                      # Size per trade
MAX_POSITION_SIZE=0.1                   # Maximum total position
CONFIDENCE_THRESHOLD=0.7                # Minimum AI confidence (0-1)

# Risk Management
STOP_LOSS_PERCENTAGE=2                  # Stop loss %
TAKE_PROFIT_PERCENTAGE=5                # Take profit %
MAX_DAILY_TRADES=10                     # Max trades per day
MAX_DAILY_LOSS=100                      # Max daily loss in USD

# System Configuration
LOG_LEVEL=info                          # debug, info, warn, error
LOG_DIR=./logs
ENABLE_LIVE_TRADING=false               # Set true for live trading
DRY_RUN=true                            # Simulate trades

# Technical Indicators
RSI_PERIOD=14
EMA_FAST=12
EMA_SLOW=26
MACD_SIGNAL=9
BOLLINGER_PERIOD=20
BOLLINGER_STD_DEV=2

# Scheduler
ENABLE_SCHEDULER=true
TRADING_START_HOUR=0                    # UTC hour (0-23)
TRADING_END_HOUR=23                     # UTC hour (0-23)

# Backtesting
BACKTEST_START_DATE=2024-01-01
BACKTEST_END_DATE=2024-12-31
BACKTEST_INITIAL_BALANCE=10000
```

---

## 📖 Usage

### Start Live Trading

```bash
npm run trade
```

This starts the bot in live/dry-run mode based on your `.env` configuration.

### Run Backtesting

```bash
npm run backtest
```

Simulates the trading strategy on historical data and generates performance metrics.

### Analyze Market

```bash
npm run analyze
```

Provides current market analysis with technical indicators and AI insights.

### Generate Report

```bash
npm run report
```

Displays statistics on AI decisions and executed trades.

### 🌐 Start Web Dashboard (NEW!)

```bash
# 1. Setup database PostgreSQL
chmod +x scripts/setup-database.sh
./scripts/setup-database.sh

# 2. Start the dashboard
npm run web
```

Apri il browser su **http://localhost:3000** per accedere alla dashboard web in tempo reale.

**Funzionalità Dashboard:**
- 📊 Statistiche live (saldo, posizioni, P&L)
- 📈 Storico operazioni con filtri
- 🎯 Performance analytics (win rate, Sharpe ratio)
- 🤖 Decisioni AI con motivazioni complete
- 🔄 Aggiornamenti real-time via WebSocket

Vedi [WEB_DASHBOARD.md](docs/WEB_DASHBOARD.md) per la guida completa.

---

## 📊 Technical Indicators

The bot calculates and analyzes the following indicators:

| Indicator | Purpose | Parameters |
|-----------|---------|------------|
| **RSI** | Momentum oscillator (overbought/oversold) | Period: 14 |
| **MACD** | Trend following momentum | Fast: 12, Slow: 26, Signal: 9 |
| **EMA** | Exponential moving average (trend) | 12 & 26 periods |
| **Bollinger Bands** | Volatility and price levels | Period: 20, StdDev: 2 |
| **SMA** | Simple moving average | Period: 20 |
| **ATR** | Average True Range (volatility) | Period: 14 |
| **Volume** | Trading volume analysis | 20-period average |

### Indicator Interpretation

- **RSI < 30**: Oversold (potential buy)
- **RSI > 70**: Overbought (potential sell)
- **MACD Crossover**: Bullish/bearish signals
- **EMA Crossover**: Trend changes
- **Bollinger Bands**: Price extremes and volatility

---

## 🧠 AI Decision Engine

The AI engine uses large language models to analyze market conditions and make trading decisions.

### Decision Process

1. **Data Collection**: Gather current price, indicators, and market context
2. **Prompt Generation**: Create structured prompt with all relevant data
3. **AI Analysis**: Send to GPT-4 or Claude for analysis
4. **Decision Parsing**: Extract BUY/SELL/HOLD decision with confidence
5. **Execution**: Execute trade if confidence > threshold

### AI Prompt Structure

The AI receives:
- Current market price and 24h change
- All technical indicators (RSI, MACD, EMA, BB, etc.)
- Recent price action (last 5 candles)
- Account balance and current positions
- Market condition assessment

The AI returns:
```json
{
  "decision": "BUY",
  "confidence": 0.85,
  "reasoning": "RSI oversold at 28, bullish MACD crossover, strong volume support...",
  "suggestedPrice": 38250.45,
  "suggestedQuantity": 0.01,
  "stopLoss": 37485.00,
  "takeProfit": 40163.00
}
```

---

## 🔄 Backtesting

### Running a Backtest

```bash
npm run backtest
```

### Backtest Metrics

The backtesting engine provides:

- **Total Trades**: Number of trades executed
- **Win Rate**: Percentage of profitable trades
- **Total P&L**: Overall profit/loss
- **ROI**: Return on investment percentage
- **Max Drawdown**: Maximum equity decline
- **Sharpe Ratio**: Risk-adjusted return
- **Average Profit**: Per trade average

### Example Output

```
═══════════════════════════════════════════════════════════
                 BACKTEST RESULTS SUMMARY
═══════════════════════════════════════════════════════════

📊 TRADE STATISTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Trades:           145
Winning Trades:         87 (60.00%)
Losing Trades:          58 (40.00%)

💰 FINANCIAL PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total P&L:              $2,450.75
ROI:                    24.51%
Avg Profit/Trade:       $16.90
Max Drawdown:           -8.32%

📈 RISK METRICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sharpe Ratio:           1.85
```

---

## 🛡️ Risk Management

### Built-in Safety Features

1. **Position Sizing**: Never risk more than configured amount per trade
2. **Daily Limits**: Stop trading after max trades or max loss reached
3. **Stop Loss**: Automatic stop-loss orders on every trade
4. **Take Profit**: Lock in profits at target levels
5. **Confidence Filter**: Only trade when AI confidence ≥ threshold

### Risk Parameters

```typescript
// Default risk settings
STOP_LOSS_PERCENTAGE=2          // 2% below entry
TAKE_PROFIT_PERCENTAGE=5        // 5% above entry
MAX_DAILY_TRADES=10             // Max 10 trades/day
MAX_DAILY_LOSS=100              // Stop if lose $100/day
CONFIDENCE_THRESHOLD=0.7        // 70% minimum confidence
```

---

## 📝 Logging & Monitoring

### Log Files

All logs are stored in the `logs/` directory:

- **application-YYYY-MM-DD.log**: General application logs
- **error-YYYY-MM-DD.log**: Error logs
- **trades-YYYY-MM-DD.log**: Trade execution logs
- **ai-decisions.json**: All AI decisions with reasoning
- **backtest-results.json**: Backtest performance data

### Log Rotation

- Logs rotate daily
- Maximum file size: 20MB
- Kept for 14 days

### Sample Log Entry

```json
{
  "timestamp": "2025-11-19T10:15:00Z",
  "level": "info",
  "message": "AI decision generated",
  "symbol": "BTC-USD",
  "decision": "BUY",
  "confidence": 0.87,
  "price": 38250.45,
  "reasoning": "RSI oversold, bullish MACD crossover..."
}
```

---

## 🧪 Testing

### Run All Tests

```bash
npm test
```

### Run with Coverage

```bash
npm run test:coverage
```

### Test Structure

```
src/
├── utils/math.test.ts              # Math utilities tests
├── services/hyperliquidService.test.ts  # API client tests
└── strategies/indicators.test.ts   # Indicator calculation tests
```

---

## 🚢 Deployment

### Production Deployment

1. **Set Environment Variables**:
   ```bash
   ENABLE_LIVE_TRADING=true
   DRY_RUN=false
   ```

2. **Build for Production**:
   ```bash
   npm run build
   ```

3. **Run with PM2** (optional):
   ```bash
   npm install -g pm2
   pm2 start dist/index.js --name trading-ai-agent
   pm2 save
   ```

4. **Monitor**:
   ```bash
   pm2 logs trading-ai-agent
   ```

### Docker Deployment (Optional)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
CMD ["node", "dist/index.js", "trade"]
```

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## ⚠️ Disclaimer

**This software is for educational purposes only. Trading cryptocurrencies involves substantial risk of loss. Never trade with money you cannot afford to lose.**

- The developers are not responsible for any financial losses
- Past performance does not guarantee future results
- Always test thoroughly in dry-run mode before live trading
- Use at your own risk

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

---

## 🙏 Acknowledgments

- [OpenAI](https://openai.com) for GPT-4 API
- [Anthropic](https://anthropic.com) for Claude API
- [Hyperliquid](https://hyperliquid.xyz) for trading infrastructure
- [TechnicalIndicators](https://github.com/anandanand84/technicalindicators) for indicator calculations

---

## 📞 Support

For issues, questions, or suggestions:

- Open an [Issue](https://github.com/yourusername/trading-ai-agent/issues)
- Check the [Documentation](https://github.com/yourusername/trading-ai-agent/wiki)

---

**Happy Trading! 🚀📈**
