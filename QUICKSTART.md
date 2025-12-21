# Trading AI Bot - Quick Start

## 🚀 Comandi Disponibili

### Avvio Completo (Web Dashboard + Bot)
```bash
npm start
```
Avvia contemporaneamente:
- 🌐 **Web Dashboard** su http://localhost:3000
- 🤖 **Trading Bot** in modalità automatica

### Comandi Separati

```bash
# Solo Web Dashboard
npm run web

# Solo Trading Bot
npm run bot  # o npm run trade

# Analisi di Mercato
npm run analyze

# Backtest Strategia
npm run backtest

# Report Performance
npm run report
```

## 📝 Configurazione

1. **Verifica `.env`:**
   - ✅ `HYPERLIQUID_SECRET` - Private key del wallet testnet
   - ✅ `HYPERLIQUID_WALLET_ADDRESS` - Indirizzo wallet
   - ✅ `HYPERLIQUID_API_URL` - URL testnet
   - ✅ **AI Provider** - Scegli tra OpenAI, DeepSeek o Anthropic
   - ✅ API key del provider scelto (vedi [MULTI-LLM.md](./MULTI-LLM.md))

2. **Setup AI (IMPORTANTE!):**
   - **Raccomandato:** DeepSeek (97% più economico di GPT-4)
   - Vedi guida completa in [MULTI-LLM.md](./MULTI-LLM.md)
   - Quick setup DeepSeek:
     ```bash
     AI_PROVIDER=deepseek
     DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxx  # Ottieni su https://platform.deepseek.com
     AI_MODEL=deepseek-chat
     ```

3. **Testnet Setup:**
   - Crea account su https://app.hyperliquid-testnet.xyz/trade
   - Riceverai automaticamente fondi virtuali
   - Copia private key e wallet address nel `.env`

3. **Database:**
   ```bash
   # Assicurati che PostgreSQL sia attivo
   sudo systemctl status postgresql
   ```

## 🎯 Modalità Trading

- **DRY_RUN=true**: Simula operazioni (nessun ordine reale)
- **DRY_RUN=false**: Esegue ordini reali sul testnet

## 📊 Dashboard Features

- **Real-time**: Aggiornamenti live via WebSocket
- **Posizioni**: Visualizza posizioni aperte/chiuse
- **Indicatori**: RSI, MACD, Bollinger Bands, ATR
- **AI Decisions**: Decisioni e confidence dell'AI
- **Performance**: P&L, win rate, Sharpe ratio

## 🛑 Fermare i Processi

```bash
# Premi Ctrl+C per terminare
# oppure
pkill -f "node dist/index.js"
```

## 📈 Monitoraggio

- **Logs**: `./logs/combined.log`
- **Database**: Tutte le operazioni salvate in PostgreSQL
- **Web**: http://localhost:3000 per dashboard visuale

## ⚠️ Note Importanti

- **Testnet**: Fondi virtuali, nessun rischio reale
- **Paper Trading**: Ideale per testare strategie
- **Mainnet**: Cambia URL solo quando sei pronto (richiede fondi reali)
