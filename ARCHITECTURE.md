# Trading AI Agent - Architecture Diagram

## System Architecture

```mermaid
graph TB
    subgraph "CLI Layer"
        CLI[CLI Commands]
    end
    
    subgraph "Core Layer"
        TradeLoop[Trade Loop]
        Scheduler[Scheduler]
        Logger[Logger]
    end
    
    subgraph "AI Layer"
        AIEngine[AI Engine]
        Prompts[Prompt Templates]
        OpenAI[OpenAI Client]
        Claude[Claude Client]
    end
    
    subgraph "Service Layer"
        HyperLiquid[Hyperliquid Service]
        MarketData[Market Data Service]
    end
    
    subgraph "Strategy Layer"
        Indicators[Technical Indicators]
        Backtest[Backtest Engine]
    end
    
    subgraph "External APIs"
        HLAPI[Hyperliquid API]
        AIAPI[AI Provider API]
    end
    
    CLI --> TradeLoop
    CLI --> Backtest
    
    TradeLoop --> Scheduler
    TradeLoop --> MarketData
    TradeLoop --> Indicators
    TradeLoop --> AIEngine
    TradeLoop --> HyperLiquid
    TradeLoop --> Logger
    
    AIEngine --> Prompts
    AIEngine --> OpenAI
    AIEngine --> Claude
    OpenAI --> AIAPI
    Claude --> AIAPI
    
    MarketData --> HyperLiquid
    HyperLiquid --> HLAPI
    
    Backtest --> MarketData
    Backtest --> Indicators
    Backtest --> AIEngine
    
    Indicators --> Logger
    
    style CLI fill:#e1f5ff
    style TradeLoop fill:#fff3cd
    style AIEngine fill:#d4edda
    style HyperLiquid fill:#f8d7da
```

## Trading Flow Sequence

```mermaid
sequenceDiagram
    participant U as User/CLI
    participant TL as Trade Loop
    participant MD as Market Data
    participant IND as Indicators
    participant AI as AI Engine
    participant HL as Hyperliquid
    participant LOG as Logger
    
    U->>TL: Start Trading
    activate TL
    
    loop Every Interval
        TL->>MD: Fetch Market Data
        MD->>HL: Get Candles
        HL-->>MD: OHLCV Data
        MD-->>TL: Market Snapshot
        
        TL->>IND: Calculate Indicators
        IND-->>TL: RSI, MACD, EMA, etc.
        
        TL->>HL: Get Account Info
        HL-->>TL: Balance & Positions
        
        TL->>AI: Request Decision
        AI->>AI: Analyze Context
        AI-->>TL: BUY/SELL/HOLD + Confidence
        
        alt Confidence >= Threshold
            alt Decision = BUY or SELL
                TL->>HL: Place Order
                HL-->>TL: Order Confirmation
                TL->>LOG: Log Trade
            else Decision = HOLD
                TL->>LOG: Log Decision
            end
        else Low Confidence
            TL->>LOG: Log Skip
        end
    end
    
    deactivate TL
```

## Data Flow

```mermaid
graph LR
    A[Hyperliquid API] -->|Market Data| B[Market Data Service]
    B -->|OHLCV Candles| C[Indicator Service]
    C -->|Technical Signals| D[AI Engine]
    B -->|Current Price| D
    E[Account Data] -->|Balance & Positions| D
    D -->|Decision + Confidence| F[Trade Loop]
    F -->|Order Request| G[Hyperliquid Service]
    G -->|Execute| A
    F -->|All Events| H[Logger]
    H -->|Files| I[(Log Storage)]
    
    style A fill:#ff6b6b
    style D fill:#4ecdc4
    style F fill:#ffe66d
    style I fill:#95e1d3
```

## Module Dependencies

```mermaid
graph TD
    A[index.ts] --> B[CLI Commands]
    B --> C[Trade Loop]
    B --> D[Backtest]
    C --> E[Scheduler]
    C --> F[Market Data Service]
    C --> G[Indicator Service]
    C --> H[AI Engine]
    C --> I[Hyperliquid Service]
    D --> F
    D --> G
    D --> H
    F --> I
    H --> J[Prompt Templates]
    H --> K[OpenAI SDK]
    H --> L[Anthropic SDK]
    G --> M[Technical Indicators Lib]
    C --> N[Logger]
    D --> N
    I --> N
    
    style A fill:#667eea
    style C fill:#764ba2
    style H fill:#f093fb
```

## Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Trade Loop** | Orchestrates trading cycle, manages state |
| **Scheduler** | Manages periodic task execution |
| **Market Data Service** | Fetches and normalizes market data |
| **Indicator Service** | Calculates technical indicators |
| **AI Engine** | Generates trading decisions using LLM |
| **Hyperliquid Service** | Executes trades and fetches account data |
| **Backtest Engine** | Simulates strategy on historical data |
| **Logger** | Structured logging with rotation |
| **CLI** | User interface and command execution |

## Error Handling Flow

```mermaid
graph TD
    A[Operation Start] --> B{Try Operation}
    B -->|Success| C[Return Result]
    B -->|Error| D{Retry?}
    D -->|Yes| E[Exponential Backoff]
    E --> F{Retries Left?}
    F -->|Yes| B
    F -->|No| G[Log Error]
    D -->|No| G
    G --> H[Graceful Degradation]
    H --> I[Continue or Exit]
    
    style A fill:#90EE90
    style C fill:#90EE90
    style G fill:#FFB6C1
    style I fill:#FFD700
```
