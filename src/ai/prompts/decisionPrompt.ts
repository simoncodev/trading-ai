import { AIPromptContext, Indicators, MultiTimeframeIndicators } from '../../types';
import { indicatorService } from '../../strategies/indicators';

/**
 * Generates a detailed trading decision prompt for the AI with multi-timeframe indicators
 */
export function generateDecisionPrompt(context: AIPromptContext): string {
  const {
    symbol,
    currentPrice,
    indicators,
    multiTfIndicators,
    recentCandles,
    accountBalance,
    currentPosition,
    marketCondition,
    openPositions = [],
    hasOpenPosition = false,
    existingPosition = null,
    unrealizedPnl = 0,
    unrealizedPnlPercentage = 0,
    tradeStats = null,
    orderBookAnalysis = null,
    additionalContext = '',
  } = context;

  const trend = indicatorService.getEMATrend(indicators);
  const isOversold = indicatorService.isRSIOversold(indicators.rsi);
  const isOverbought = indicatorService.isRSIOverbought(indicators.rsi);
  const macdBullish = indicatorService.isMACDBullishCrossover(indicators.macd);
  const macdBearish = indicatorService.isMACDBearishCrossover(indicators.macd);

  // Get recent price action
  const recentPriceChange = recentCandles.length >= 2
    ? ((currentPrice - recentCandles[0].close) / recentCandles[0].close) * 100
    : 0;

  // Multi-timeframe section (if available)
  const multiTfSection = multiTfIndicators ? generateMultiTimeframeSection(multiTfIndicators, currentPrice) : '';
  
  // Order book section (if available)
  const orderBookSection = orderBookAnalysis ? generateOrderBookSection(orderBookAnalysis) : '';

  // Additional context section (for hybrid mode)
  const additionalContextSection = additionalContext ? `
## 🔀 HYBRID MODE - ORDER BOOK PRE-ANALYSIS
${additionalContext}
` : '';

  const prompt = `You are an expert cryptocurrency trading AI assistant analyzing ${symbol}.
${additionalContextSection}
## CURRENT MARKET DATA
- **Current Price**: $${currentPrice.toFixed(2)}
- **Recent Price Change**: ${recentPriceChange.toFixed(2)}%
- **Market Condition**: ${marketCondition}

${multiTfSection}
${orderBookSection}

## LEGACY INDICATORS (for reference)
- **RSI**: ${indicators.rsi.toFixed(2)} ${isOversold ? '(OVERSOLD)' : isOverbought ? '(OVERBOUGHT)' : '(NEUTRAL)'}
- **EMA Trend**: ${trend.toUpperCase()}
- **MACD Histogram**: ${indicators.macd.histogram.toFixed(4)} ${macdBullish ? '(BULLISH)' : macdBearish ? '(BEARISH)' : ''}
- **BB Position**: ${getBBPosition(currentPrice, indicators)}
- **ATR**: ${indicators.atr.toFixed(4)}

## ACCOUNT STATUS
- **Available Balance**: $${accountBalance.toFixed(2)}
- **Total Open Positions**: ${openPositions.length}/5
- **Unrealized P&L**: $${unrealizedPnl.toFixed(2)} (${unrealizedPnlPercentage.toFixed(2)}%)
- **Performance**: ${unrealizedPnl >= 0 ? '✅ Profitable' : '⚠️ In Loss'}

## TRADING PERFORMANCE HISTORY
${tradeStats && tradeStats.totalTrades > 0 ? `
- **Total Closed Trades**: ${tradeStats.totalTrades}
- **Win Rate**: ${tradeStats.winRate.toFixed(1)}% ${tradeStats.winRate >= 50 ? '✅' : '⚠️'}
- **Recent Win Rate (last 20)**: ${tradeStats.recentWinRate.toFixed(1)}% ${tradeStats.recentWinRate >= 50 ? '✅' : '⚠️'}
- **Profit Factor**: ${tradeStats.profitFactor.toFixed(2)} ${tradeStats.profitFactor >= 1 ? '✅' : '⚠️'}
- **Avg Win**: $${tradeStats.averageWin.toFixed(4)} | Avg Loss: $${tradeStats.averageLoss.toFixed(4)}
- **Consecutive Losses**: ${tradeStats.consecutiveLosses} ${tradeStats.consecutiveLosses >= 3 ? '⚠️ CAUTION: Losing streak!' : ''}
${tradeStats.consecutiveLosses >= 5 ? `
⛔ **WARNING**: You have ${tradeStats.consecutiveLosses} consecutive losses! Consider:
  - Being more conservative with entries
  - Requiring higher confidence thresholds
  - Waiting for clearer signals
` : ''}${tradeStats.winRate < 40 ? `
⚠️ **WARNING**: Win rate below 40%! Review your entry criteria.
` : ''}` : '- **No closed trades yet** - Building trading history...'}
${hasOpenPosition && existingPosition ? `
- **EXISTING POSITION ON ${symbol}**: 
  - Side: ${existingPosition.side.toUpperCase()}
  - Quantity: ${parseFloat(existingPosition.quantity).toFixed(4)}
  - Entry Price: $${parseFloat(existingPosition.entry_price).toFixed(2)}
  - Leverage: ${parseFloat(existingPosition.leverage || 1).toFixed(0)}x
  - Status: OPEN
  - **⚠️ IMPORTANT**: You already have a ${existingPosition.side.toUpperCase()} position on ${symbol}!
    - If recommending BUY and position is already BUY → suggest HOLD (avoid duplicate)
    - If recommending SELL and position is already SELL → suggest HOLD (avoid duplicate)
    - If signal is opposite to existing position → you can suggest closing + reversing
` : `- **Current Position on ${symbol}**: None (you can open a new position)`}
${currentPosition ? `- **Hyperliquid Position**: ${currentPosition.side.toUpperCase()} ${currentPosition.size} @ $${currentPosition.entryPrice.toFixed(2)}
- **Unrealized P&L**: $${currentPosition.unrealizedPnL.toFixed(2)} (${((currentPosition.unrealizedPnL / (currentPosition.entryPrice * currentPosition.size)) * 100).toFixed(2)}%)` : ''}

## RECENT PRICE ACTION (Last 5 Candles)
${formatRecentCandles(recentCandles.slice(-5))}

---

## YOUR TASK
You are a **SCALPING TRADER** on ${symbol} with 1-minute timeframe. 

**MULTI-TIMEFRAME DECISION FRAMEWORK:**
Use ALL the indicator timeframes provided to make better decisions:

1. **Short-term (RSI-7, EMA 5/13, MACD fast)**: For timing entries precisely
2. **Medium-term (RSI-14, EMA 12/26, MACD standard)**: For confirming the trend
3. **Long-term (RSI-21, EMA 20/50, SMA levels)**: For overall market context

**IDEAL ENTRY CONDITIONS:**
- **STRONG BUY**: All timeframes bullish + RSI short oversold + Volume spike
- **MODERATE BUY**: 2/3 timeframes bullish + RSI < 40
- **STRONG SELL**: All timeframes bearish + RSI short overbought
- **MODERATE SELL**: 2/3 timeframes bearish + RSI > 60
- **HOLD**: Conflicting signals OR no clear setup

**RISK MANAGEMENT:**
- Stop Loss: 1% max (use ATR for guidance)
- Take Profit: 2% (use BB bands for targets)
- Fees: 0.035% taker per trade (0.07% round trip)
- Minimum expected move to profit: >0.1% after fees

**Respond ONLY with a valid JSON object:**

\`\`\`json
{
  "decision": "BUY" | "SELL" | "HOLD",
  "confidence": 0.55-1.0,
  "reasoning": "Multi-timeframe analysis: [short-term view] + [medium-term view] + [specific trigger]",
  "suggestedPrice": ${currentPrice.toFixed(2)},
  "stopLoss": ${(currentPrice * 0.99).toFixed(2)},
  "takeProfit": ${(currentPrice * 1.02).toFixed(2)}
}
\`\`\`

**SCALPING RULES:**
- **Confidence threshold**: 0.55-0.80 range
- **Stop Loss**: 0.5-1% (tight!)
- **Take Profit**: 1-2% (quick gains)
- **Be decisive**: If 2+ timeframes agree, ACT!

Provide your MULTI-TIMEFRAME SCALPING analysis NOW:`;

  return prompt;
}

/**
 * Generates the multi-timeframe indicators section
 */
function generateMultiTimeframeSection(mtf: MultiTimeframeIndicators, currentPrice: number): string {
  const rsiShortStatus = mtf.rsi.short < 30 ? '🟢 OVERSOLD' : mtf.rsi.short > 70 ? '🔴 OVERBOUGHT' : '⚪ NEUTRAL';
  const rsiMediumStatus = mtf.rsi.medium < 30 ? '🟢 OVERSOLD' : mtf.rsi.medium > 70 ? '🔴 OVERBOUGHT' : '⚪ NEUTRAL';
  const rsiLongStatus = mtf.rsi.long < 30 ? '🟢 OVERSOLD' : mtf.rsi.long > 70 ? '🔴 OVERBOUGHT' : '⚪ NEUTRAL';

  const trendEmoji = (trend: string) => trend === 'bullish' ? '🟢' : trend === 'bearish' ? '🔴' : '⚪';

  return `## 📊 MULTI-TIMEFRAME INDICATORS ANALYSIS

### RSI Analysis (Relative Strength Index)
| Timeframe | Period | Value | Status |
|-----------|--------|-------|--------|
| Short-term (Scalping) | RSI-7 | ${mtf.rsi.short.toFixed(1)} | ${rsiShortStatus} |
| Medium-term (Standard) | RSI-14 | ${mtf.rsi.medium.toFixed(1)} | ${rsiMediumStatus} |
| Long-term (Trend) | RSI-21 | ${mtf.rsi.long.toFixed(1)} | ${rsiLongStatus} |

**RSI Consensus**: ${getRSIConsensus(mtf.rsi)}

### EMA Trend Analysis
| Timeframe | Fast EMA | Slow EMA | Trend |
|-----------|----------|----------|-------|
| Scalping (5/13) | $${mtf.ema.scalping.fast.toFixed(2)} | $${mtf.ema.scalping.slow.toFixed(2)} | ${trendEmoji(mtf.ema.scalping.trend)} ${mtf.ema.scalping.trend.toUpperCase()} |
| Standard (12/26) | $${mtf.ema.standard.fast.toFixed(2)} | $${mtf.ema.standard.slow.toFixed(2)} | ${trendEmoji(mtf.ema.standard.trend)} ${mtf.ema.standard.trend.toUpperCase()} |
| Swing (20/50) | $${mtf.ema.swing.fast.toFixed(2)} | $${mtf.ema.swing.slow.toFixed(2)} | ${trendEmoji(mtf.ema.swing.trend)} ${mtf.ema.swing.trend.toUpperCase()} |

**EMA Consensus**: ${getEMAConsensus(mtf.ema)}

### MACD Analysis
| Setting | MACD | Signal | Histogram | Status |
|---------|------|--------|-----------|--------|
| Fast (5/13/5) | ${mtf.macd.fast.macd.toFixed(4)} | ${mtf.macd.fast.signal.toFixed(4)} | ${mtf.macd.fast.histogram.toFixed(4)} | ${mtf.macd.fast.histogram > 0 ? '🟢 BULLISH' : '🔴 BEARISH'} |
| Standard (12/26/9) | ${mtf.macd.standard.macd.toFixed(4)} | ${mtf.macd.standard.signal.toFixed(4)} | ${mtf.macd.standard.histogram.toFixed(4)} | ${mtf.macd.standard.histogram > 0 ? '🟢 BULLISH' : '🔴 BEARISH'} |

**MACD Consensus**: ${getMACDConsensus(mtf.macd)}

### Bollinger Bands
| Setting | Lower | Middle | Upper | Price Position |
|---------|-------|--------|-------|----------------|
| Tight (10, 1.5σ) | $${mtf.bollingerBands.tight.lower.toFixed(2)} | $${mtf.bollingerBands.tight.middle.toFixed(2)} | $${mtf.bollingerBands.tight.upper.toFixed(2)} | ${getBBPositionEmoji(currentPrice, mtf.bollingerBands.tight)} |
| Standard (20, 2σ) | $${mtf.bollingerBands.standard.lower.toFixed(2)} | $${mtf.bollingerBands.standard.middle.toFixed(2)} | $${mtf.bollingerBands.standard.upper.toFixed(2)} | ${getBBPositionEmoji(currentPrice, mtf.bollingerBands.standard)} |

### Volatility (ATR)
- **ATR-7** (Short): ${mtf.atr.short.toFixed(4)} (${((mtf.atr.short / currentPrice) * 100).toFixed(3)}%)
- **ATR-14** (Medium): ${mtf.atr.medium.toFixed(4)} (${((mtf.atr.medium / currentPrice) * 100).toFixed(3)}%)

### Volume Analysis
- **Current Volume**: ${mtf.volume.current.toFixed(2)}
- **Avg Volume (20)**: ${mtf.volume.average20.toFixed(2)}
- **Volume Ratio**: ${mtf.volume.ratio.toFixed(2)}x ${mtf.volume.isHigh ? '📈 HIGH VOLUME' : '📉 Normal'}

### SMA Levels (Support/Resistance)
- **SMA-10**: $${mtf.sma.sma10.toFixed(2)} ${currentPrice > mtf.sma.sma10 ? '(above)' : '(below)'}
- **SMA-20**: $${mtf.sma.sma20.toFixed(2)} ${currentPrice > mtf.sma.sma20 ? '(above)' : '(below)'}
- **SMA-50**: $${mtf.sma.sma50.toFixed(2)} ${currentPrice > mtf.sma.sma50 ? '(above)' : '(below)'}

### 🎯 AGGREGATED SIGNALS
${formatSignals(mtf.signals)}`;
}

function getRSIConsensus(rsi: MultiTimeframeIndicators['rsi']): string {
  const oversoldCount = [rsi.short < 30, rsi.medium < 30, rsi.long < 30].filter(Boolean).length;
  const overboughtCount = [rsi.short > 70, rsi.medium > 70, rsi.long > 70].filter(Boolean).length;
  
  if (oversoldCount >= 2) return '🟢 **STRONG OVERSOLD** - Consider BUY';
  if (overboughtCount >= 2) return '🔴 **STRONG OVERBOUGHT** - Consider SELL';
  if (rsi.short < 40 && rsi.medium < 50) return '🟡 **LEANING OVERSOLD**';
  if (rsi.short > 60 && rsi.medium > 50) return '🟡 **LEANING OVERBOUGHT**';
  return '⚪ **NEUTRAL** - No clear RSI signal';
}

function getEMAConsensus(ema: MultiTimeframeIndicators['ema']): string {
  const bullishCount = [ema.scalping.trend, ema.standard.trend, ema.swing.trend].filter(t => t === 'bullish').length;
  const bearishCount = [ema.scalping.trend, ema.standard.trend, ema.swing.trend].filter(t => t === 'bearish').length;
  
  if (bullishCount === 3) return '🟢 **ALL BULLISH** - Strong uptrend across all timeframes';
  if (bearishCount === 3) return '🔴 **ALL BEARISH** - Strong downtrend across all timeframes';
  if (bullishCount >= 2) return '🟡 **MOSTLY BULLISH** - Uptrend with some resistance';
  if (bearishCount >= 2) return '🟡 **MOSTLY BEARISH** - Downtrend with some support';
  return '⚪ **MIXED/CHOPPY** - No clear trend consensus';
}

function getMACDConsensus(macd: MultiTimeframeIndicators['macd']): string {
  const fastBullish = macd.fast.histogram > 0;
  const standardBullish = macd.standard.histogram > 0;
  
  if (fastBullish && standardBullish) return '🟢 **DOUBLE BULLISH** - Momentum confirmed';
  if (!fastBullish && !standardBullish) return '🔴 **DOUBLE BEARISH** - Downside momentum';
  if (fastBullish && !standardBullish) return '🟡 **SHORT-TERM BOUNCE** - Fast bullish, but trend still bearish';
  return '🟡 **SHORT-TERM PULLBACK** - Fast bearish, but trend still bullish';
}

function getBBPositionEmoji(price: number, bb: { upper: number; middle: number; lower: number }): string {
  if (price >= bb.upper) return '🔴 Above Upper (Overbought)';
  if (price <= bb.lower) return '🟢 Below Lower (Oversold)';
  if (price > bb.middle) return '📈 Upper Half';
  return '📉 Lower Half';
}

function formatSignals(signals: MultiTimeframeIndicators['signals']): string {
  const bullish: string[] = [];
  const bearish: string[] = [];
  
  if (signals.rsiOversold) bullish.push('RSI Oversold');
  if (signals.macdBullish) bullish.push('MACD Bullish');
  if (signals.priceAboveEMA) bullish.push('Price > EMAs');
  if (signals.nearBBLower) bullish.push('Near BB Lower');
  if (signals.highVolume) bullish.push('High Volume');
  
  if (signals.rsiOverbought) bearish.push('RSI Overbought');
  if (signals.macdBearish) bearish.push('MACD Bearish');
  if (signals.priceBelowEMA) bearish.push('Price < EMAs');
  if (signals.nearBBUpper) bearish.push('Near BB Upper');
  
  let result = '';
  if (bullish.length > 0) result += `- 🟢 **BULLISH**: ${bullish.join(', ')}\n`;
  if (bearish.length > 0) result += `- 🔴 **BEARISH**: ${bearish.join(', ')}\n`;
  if (bullish.length === 0 && bearish.length === 0) result += '- ⚪ **NO STRONG SIGNALS**\n';
  
  const netSignal = bullish.length - bearish.length;
  if (netSignal >= 2) result += '\n**NET BIAS: 🟢 STRONGLY BULLISH**';
  else if (netSignal >= 1) result += '\n**NET BIAS: 🟡 SLIGHTLY BULLISH**';
  else if (netSignal <= -2) result += '\n**NET BIAS: 🔴 STRONGLY BEARISH**';
  else if (netSignal <= -1) result += '\n**NET BIAS: 🟡 SLIGHTLY BEARISH**';
  else result += '\n**NET BIAS: ⚪ NEUTRAL**';
  
  return result;
}

/**
 * Generates the order book analysis section
 */
function generateOrderBookSection(ob: NonNullable<AIPromptContext['orderBookAnalysis']>): string {
  const imbalancePercent = (ob.imbalanceRatio * 100).toFixed(1);
  const signalDirection = ob.orderBookSignal > 0.2 ? '🟢 BULLISH' : ob.orderBookSignal < -0.2 ? '🔴 BEARISH' : '⚪ NEUTRAL';
  
  let wallInfo = '';
  if (ob.nearestBidWall) {
    wallInfo += `\n  - **Support Wall**: $${ob.nearestBidWall.price.toFixed(2)} (${ob.nearestBidWall.size.toFixed(2)} @ ${ob.nearestBidWall.distancePercent.toFixed(2)}% below)`;
  }
  if (ob.nearestAskWall) {
    wallInfo += `\n  - **Resistance Wall**: $${ob.nearestAskWall.price.toFixed(2)} (${ob.nearestAskWall.size.toFixed(2)} @ ${ob.nearestAskWall.distancePercent.toFixed(2)}% above)`;
  }

  return `
## 📊 ORDER BOOK ANALYSIS
- **Bid/Ask Imbalance**: ${imbalancePercent}% (${ob.imbalanceSignal})
  - Positive = More buying pressure, Negative = More selling pressure
- **Order Book Signal**: ${ob.orderBookSignal.toFixed(3)} ${signalDirection}
- **Signal Confidence**: ${(ob.confidence * 100).toFixed(0)}%
- **Spread**: ${ob.spread.toFixed(4)}% ${ob.spread > 0.1 ? '⚠️ Wide spread' : '✅ Tight spread'}
- **Liquidity Score**: ${ob.liquidityScore}/100 ${ob.liquidityScore >= 70 ? '✅' : ob.liquidityScore >= 40 ? '⚪' : '⚠️'}
- **Bid Pressure**: ${(ob.bidPressure * 100).toFixed(1)}% | **Ask Pressure**: ${(ob.askPressure * 100).toFixed(1)}%${wallInfo}

**ORDER BOOK TRADING RULES:**
- Imbalance > +30% = Strong buying interest → BUY signal
- Imbalance < -30% = Strong selling interest → SELL signal
- Large bid wall nearby = Support level → Consider BUY
- Large ask wall nearby = Resistance level → Consider SELL
- Wide spread (>0.1%) = Poor liquidity, be cautious
- Low liquidity (<40) = Avoid trading or reduce size
`;
}

/**
 * Helper function to determine Bollinger Band position
 */
function getBBPosition(price: number, indicators: Indicators): string {
  const { upper, middle, lower } = indicators.bollingerBands;
  
  if (price > upper) return 'Above Upper Band (Overbought)';
  if (price < lower) return 'Below Lower Band (Oversold)';
  if (price > middle) return 'Upper Half (Bullish)';
  if (price < middle) return 'Lower Half (Bearish)';
  return 'Middle (Neutral)';
}

/**
 * Formats recent candles for the prompt
 */
function formatRecentCandles(candles: any[]): string {
  if (!candles || candles.length === 0) return 'No recent candle data available';

  return candles.map((candle, i) => {
    const date = new Date(candle.timestamp).toISOString().slice(11, 19);
    const change = i > 0 ? ((candle.close - candles[i - 1].close) / candles[i - 1].close) * 100 : 0;
    return `${date} | O: $${candle.open.toFixed(2)} | H: $${candle.high.toFixed(2)} | L: $${candle.low.toFixed(2)} | C: $${candle.close.toFixed(2)} | V: ${candle.volume.toFixed(0)} | Change: ${change > 0 ? '+' : ''}${change.toFixed(2)}%`;
  }).join('\n');
}

/**
 * Generates a simpler prompt for quick decisions
 */
export function generateQuickDecisionPrompt(
  symbol: string,
  currentPrice: number,
  indicators: Indicators
): string {
  return `Analyze ${symbol} at $${currentPrice.toFixed(2)}.

Indicators: RSI ${indicators.rsi.toFixed(0)}, MACD ${indicators.macd.histogram > 0 ? 'bullish' : 'bearish'}, EMA trend ${indicatorService.getEMATrend(indicators)}.

Provide JSON decision: {"decision": "BUY"|"SELL"|"HOLD", "confidence": 0-1, "reasoning": "brief explanation"}`;
}

/**
 * Generates a prompt for backtesting analysis
 */
export function generateBacktestAnalysisPrompt(
  symbol: string,
  trades: any[],
  metrics: any
): string {
  return `Analyze trading performance for ${symbol}:

## Performance Metrics
- Total Trades: ${trades.length}
- Win Rate: ${(metrics.winRate * 100).toFixed(2)}%
- Total P&L: $${metrics.totalPnL.toFixed(2)}
- ROI: ${(metrics.roi * 100).toFixed(2)}%
- Max Drawdown: ${metrics.maxDrawdown.toFixed(2)}%

## Recent Trades (Last 5)
${trades.slice(-5).map((t: any) => `${t.side.toUpperCase()} @ $${t.entryPrice.toFixed(2)} | P&L: $${(t.pnl || 0).toFixed(2)}`).join('\n')}

Provide insights on strategy performance and suggestions for improvement.`;
}
