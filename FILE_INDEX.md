# Trading AI Agent - Complete File Index

## 📁 Complete Project File List

### Root Configuration Files
- `package.json` - Project dependencies and scripts
- `package-lock.json` - Locked dependency versions
- `tsconfig.json` - TypeScript compiler configuration
- `jest.config.js` - Jest testing framework configuration
- `.eslintrc.json` - ESLint linting rules
- `.prettierrc.json` - Prettier code formatting rules
- `.env` - Environment variables (DO NOT COMMIT)
- `.env.example` - Environment template
- `.gitignore` - Git exclusion rules
- `LICENSE` - MIT license

### Documentation Files
- `README.md` - Main project documentation (500+ lines)
- `ARCHITECTURE.md` - System architecture and diagrams
- `CONTRIBUTING.md` - Contribution guidelines
- `CHANGELOG.md` - Version history and changes
- `PROJECT_SUMMARY.md` - Quick start guide
- `COMPLETION_REPORT.md` - Project completion status
- `FILE_INDEX.md` - This file

### Source Code - Core (`src/core/`)
- `logger.ts` - Winston logging configuration (150 lines)
- `scheduler.ts` - Cron-based task scheduler (160 lines)
- `tradeLoop.ts` - Main trading loop orchestration (350 lines)

### Source Code - AI (`src/ai/`)
- `aiEngine.ts` - OpenAI & Anthropic integration (230 lines)
- `prompts/decisionPrompt.ts` - AI prompt templates (180 lines)

### Source Code - Services (`src/services/`)
- `hyperliquidService.ts` - Exchange API client (330 lines)
- `marketDataService.ts` - Market data fetching (170 lines)

### Source Code - Strategies (`src/strategies/`)
- `indicators.ts` - Technical indicator calculations (280 lines)
- `backtest.ts` - Backtesting engine (320 lines)

### Source Code - Utilities (`src/utils/`)
- `config.ts` - Configuration management (120 lines)
- `constants.ts` - Application constants (100 lines)
- `math.ts` - Mathematical utilities (180 lines)

### Source Code - CLI (`src/cli/`)
- `commands.ts` - CLI command implementations (280 lines)

### Source Code - Types (`src/types/`)
- `index.d.ts` - TypeScript type definitions (350 lines)

### Source Code - Entry Point (`src/`)
- `index.ts` - Application entry point (75 lines)

### Test Files (`src/`)
- `utils/math.test.ts` - Math utility tests
- `services/hyperliquidService.test.ts` - API client tests
- `strategies/indicators.test.ts` - Indicator tests

### Build Output (`dist/`) - Generated
- Compiled JavaScript files (automatically generated)
- Source maps (.js.map files)
- Type declaration files (.d.ts files)

### Runtime Directories
- `logs/` - Log files (created at runtime)
  - `application-YYYY-MM-DD.log`
  - `error-YYYY-MM-DD.log`
  - `trades-YYYY-MM-DD.log`
  - `ai-decisions.json`
  - `backtest-results.json`

---

## 📊 File Statistics

| Category | Count | Lines |
|----------|-------|-------|
| **Source Files** | 18 | 3,252 |
| **Test Files** | 3 | ~200 |
| **Config Files** | 5 | ~150 |
| **Documentation** | 6 | ~1,500 |
| **Total** | **32+** | **~5,100+** |

---

## 🗂️ File Dependencies

### High-Level Dependencies
```
index.ts
  ├── cli/commands.ts
  │   ├── core/tradeLoop.ts
  │   │   ├── core/scheduler.ts
  │   │   ├── services/marketDataService.ts
  │   │   ├── services/hyperliquidService.ts
  │   │   ├── strategies/indicators.ts
  │   │   ├── ai/aiEngine.ts
  │   │   └── core/logger.ts
  │   └── strategies/backtest.ts
  ├── utils/config.ts
  └── types/index.d.ts
```

---

## 📝 Important Files to Review

### For Getting Started
1. **README.md** - Start here for overview
2. **PROJECT_SUMMARY.md** - Quick start guide
3. **.env.example** - Configuration template

### For Understanding Code
1. **src/index.ts** - Entry point
2. **src/core/tradeLoop.ts** - Main logic
3. **src/ai/aiEngine.ts** - AI integration
4. **ARCHITECTURE.md** - System design

### For Configuration
1. **.env** - Your configuration
2. **src/utils/config.ts** - Config loader
3. **src/utils/constants.ts** - Default values

### For Development
1. **package.json** - Scripts and dependencies
2. **tsconfig.json** - TypeScript settings
3. **jest.config.js** - Test settings

---

## 🔧 Key Configuration Files Explained

### `package.json`
Defines project metadata, dependencies, and npm scripts.
**Most used scripts:**
- `npm run trade` - Start trading
- `npm run build` - Compile TypeScript
- `npm test` - Run tests

### `tsconfig.json`
TypeScript compiler configuration.
**Key settings:**
- Strict mode enabled
- ES2022 target
- Source maps enabled
- Path aliases configured

### `.env`
Runtime configuration (create from `.env.example`)
**Required variables:**
- API keys (Hyperliquid, OpenAI/Claude)
- Trading parameters
- Risk management settings

---

## 📦 Dependencies Overview

### Production Dependencies (20+)
- **axios** - HTTP client
- **openai** - OpenAI API
- **@anthropic-ai/sdk** - Claude API
- **winston** - Logging
- **node-schedule** - Scheduling
- **technicalindicators** - TA calculations
- **dotenv** - Environment variables

### Development Dependencies (15+)
- **typescript** - Type system
- **jest** - Testing
- **eslint** - Linting
- **prettier** - Formatting
- **ts-jest** - TS testing

---

## 🎯 File Modification Guide

### To Change Trading Logic
- Modify: `src/core/tradeLoop.ts`
- Consider: Risk management in `src/utils/config.ts`

### To Adjust AI Behavior
- Modify: `src/ai/prompts/decisionPrompt.ts`
- Consider: `src/ai/aiEngine.ts` for response parsing

### To Add Indicators
- Modify: `src/strategies/indicators.ts`
- Add to: `src/types/index.d.ts` (Indicators interface)

### To Change Risk Settings
- Modify: `.env` file
- Defaults in: `src/utils/constants.ts`

### To Add Commands
- Modify: `src/cli/commands.ts`
- Update: `src/index.ts` (command router)

---

## 🔍 Finding Specific Code

### Trading Logic
- **Main loop**: `src/core/tradeLoop.ts:executeTradingCycle()`
- **Order execution**: `src/services/hyperliquidService.ts:placeOrder()`
- **Decision making**: `src/ai/aiEngine.ts:generateDecision()`

### Data Processing
- **Fetching candles**: `src/services/marketDataService.ts:getCandles()`
- **Calculating indicators**: `src/strategies/indicators.ts:getIndicators()`
- **Market analysis**: `src/strategies/indicators.ts:analyzeMarket()`

### Configuration
- **Loading config**: `src/utils/config.ts:config`
- **Validation**: `src/utils/config.ts:validateConfig()`
- **Constants**: `src/utils/constants.ts`

---

## 📁 Directory Purpose

| Directory | Purpose |
|-----------|---------|
| `src/core/` | Core system components |
| `src/ai/` | AI integration and prompts |
| `src/services/` | External API integrations |
| `src/strategies/` | Trading strategies and analysis |
| `src/utils/` | Utility functions |
| `src/cli/` | Command-line interface |
| `src/types/` | TypeScript type definitions |
| `dist/` | Compiled JavaScript output |
| `logs/` | Runtime log files |
| `node_modules/` | Installed dependencies |

---

*This index provides a complete overview of all project files and their purposes.*
