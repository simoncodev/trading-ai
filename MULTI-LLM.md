# 🤖 Guida Multi-LLM - Scegli il tuo AI Provider

Il bot supporta 3 provider AI con diversi costi e performance:

## 🎯 Provider Disponibili

### 1. DeepSeek (RACCOMANDATO 💰)
**Costo: ~$0.14 per 1M tokens (97% più economico di GPT-4!)**

```bash
# Nel file .env:
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxx
AI_MODEL=deepseek-chat  # o deepseek-coder
```

**Ottieni API Key:**
1. Vai su https://platform.deepseek.com
2. Crea account e vai su "API Keys"
3. Copia la chiave (inizia con `sk-`)
4. Incollala nel `.env`

**Pro:**
- ✅ Costo bassissimo (~$0.0003 per 1k tokens)
- ✅ Performance comparabili a GPT-4
- ✅ Velocità eccellente
- ✅ Supporto JSON nativo

**Contro:**
- ⚠️ Meno conosciuto di OpenAI
- ⚠️ Documentazione in inglese/cinese

**Modelli disponibili:**
- `deepseek-chat` - Modello generale (raccomandato)
- `deepseek-coder` - Ottimizzato per codice

---

### 2. OpenAI (GPT-4, GPT-3.5)
**Costo: $0.01-0.03 per 1k tokens**

```bash
# Nel file .env:
AI_PROVIDER=openai
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxx
AI_MODEL=gpt-4-turbo-preview  # o gpt-3.5-turbo
```

**Ottieni API Key:**
1. Vai su https://platform.openai.com/api-keys
2. Clicca "Create new secret key"
3. Copia la chiave (inizia con `sk-proj-`)
4. Incollala nel `.env`

**Pro:**
- ✅ Più conosciuto e testato
- ✅ Ottima documentazione
- ✅ Performance eccellenti

**Contro:**
- 💸 Costoso per uso intensivo
- ⚠️ Rate limits più restrittivi

**Modelli disponibili:**
- `gpt-4-turbo-preview` - Migliore qualità
- `gpt-4` - Ottimo bilanciamento
- `gpt-3.5-turbo` - Più economico (~$0.0015/1k tokens)

---

### 3. Anthropic Claude
**Costo: $0.003-0.015 per 1k tokens**

```bash
# Nel file .env:
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxx
AI_MODEL=claude-3-5-sonnet-20241022
```

**Ottieni API Key:**
1. Vai su https://console.anthropic.com/settings/keys
2. Clicca "Create Key"
3. Copia la chiave (inizia con `sk-ant-`)
4. Incollala nel `.env`

**Pro:**
- ✅ Ottima qualità di reasoning
- ✅ Veloce e affidabile
- ✅ Buon bilanciamento costo/performance

**Contro:**
- 💸 Più costoso di DeepSeek
- ⚠️ Richiede setup JSON parsing

**Modelli disponibili:**
- `claude-3-5-sonnet-20241022` - Migliore (raccomandato)
- `claude-3-opus-20240229` - Più costoso ma più potente
- `claude-3-sonnet-20240229` - Bilanciato

---

## 💰 Confronto Costi (1M tokens)

| Provider | Modello | Input Cost | Output Cost | Totale ~1M |
|----------|---------|------------|-------------|------------|
| **DeepSeek** | deepseek-chat | $0.14 | $0.28 | **$0.21** ⭐ |
| OpenAI | gpt-3.5-turbo | $0.50 | $1.50 | $1.00 |
| OpenAI | gpt-4-turbo | $10.00 | $30.00 | $20.00 |
| Anthropic | claude-3-sonnet | $3.00 | $15.00 | $9.00 |
| Anthropic | claude-3-opus | $15.00 | $75.00 | $45.00 |

*Prezzi approssimativi - verifica sui siti ufficiali*

---

## 🔄 Come Cambiare Provider

1. **Modifica `.env`:**
```bash
# Cambia solo queste 3 righe:
AI_PROVIDER=deepseek           # o openai, anthropic
DEEPSEEK_API_KEY=sk-xxxxx      # la tua chiave
AI_MODEL=deepseek-chat         # modello del provider scelto
```

2. **Riavvia il bot:**
```bash
npm start
```

Il bot rileverà automaticamente il nuovo provider!

---

## 📊 Quale Scegliere?

### Per Paper Trading / Testing:
→ **DeepSeek** - Costi minimi, performance ottime

### Per Trading Reale con budget limitato:
→ **DeepSeek** o **GPT-3.5-turbo** - Buon bilanciamento

### Per Trading Professionale:
→ **GPT-4** o **Claude 3.5 Sonnet** - Migliore qualità

### Per Massima Sicurezza:
→ **Claude Opus** - Reasoning più accurato (più costoso)

---

## ✅ Test Veloce

Prova il provider attuale con:
```bash
npm run analyze
```

Vedrai quale AI provider è in uso nei log:
```
[info]: AI Engine initialized with DeepSeek
```

---

## 🛟 Troubleshooting

**Errore: "401 Incorrect API key"**
- Verifica che la chiave sia corretta nel `.env`
- Controlla di aver settato la chiave del provider giusto
- Assicurati che la chiave non abbia spazi extra

**Errore: "AI client not configured"**
- Verifica che `AI_PROVIDER` corrisponda alla chiave inserita
- Se usi `deepseek`, serve `DEEPSEEK_API_KEY`
- Se usi `openai`, serve `OPENAI_API_KEY`
- Se usi `anthropic`, serve `ANTHROPIC_API_KEY`

**Troppi errori di rate limit:**
- DeepSeek: limite più alto
- OpenAI: prova `gpt-3.5-turbo` o aumenta il delay
- Anthropic: buoni limiti standard
