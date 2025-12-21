import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config';
import { logger } from '../core/logger';
import { AIResponse, AIPromptContext, AIError } from '../types';
import { generateDecisionPrompt } from './prompts/decisionPrompt';
import { AI_CONSTANTS } from '../utils/constants';

/**
 * AI Engine for making trading decisions using LLM models
 * Supports: OpenAI, DeepSeek, Anthropic Claude
 */
class AIEngine {
  private openaiClient?: OpenAI;
  private deepseekClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private provider: 'openai' | 'deepseek' | 'anthropic';

  constructor() {
    this.provider = config.ai.provider as 'openai' | 'deepseek' | 'anthropic';

    if (this.provider === 'openai') {
      this.openaiClient = new OpenAI({
        apiKey: config.ai.apiKey,
      });
      logger.info('AI Engine initialized with OpenAI');
    } else if (this.provider === 'deepseek') {
      this.deepseekClient = new OpenAI({
        apiKey: config.ai.apiKey,
        baseURL: 'https://api.deepseek.com/v3.2_speciale_expires_on_20251215',
      });
      logger.info('AI Engine initialized with DeepSeek');
    } else if (this.provider === 'anthropic') {
      this.anthropicClient = new Anthropic({
        apiKey: config.ai.apiKey,
      });
      logger.info('AI Engine initialized with Anthropic Claude');
    } else {
      logger.warn(`Unknown AI provider: ${this.provider}, falling back to OpenAI`);
      this.provider = 'openai';
      this.openaiClient = new OpenAI({
        apiKey: config.ai.apiKey,
      });
    }
  }

  /**
   * Generates a trading decision using AI
   */
  async generateDecision(context: AIPromptContext): Promise<AIResponse> {
    const prompt = generateDecisionPrompt(context);

    logger.debug('Generating AI decision', {
      symbol: context.symbol,
      currentPrice: context.currentPrice,
    });

    try {
      let response: AIResponse;

      if (this.provider === 'openai' && this.openaiClient) {
        response = await this.getOpenAIDecision(prompt);
      } else if (this.provider === 'deepseek' && this.deepseekClient) {
        response = await this.getDeepSeekDecision(prompt);
      } else if (this.provider === 'anthropic' && this.anthropicClient) {
        response = await this.getAnthropicDecision(prompt);
      } else {
        throw new AIError('No AI client configured');
      }

      // Validate response
      this.validateAIResponse(response);

      logger.aiDecision('AI decision generated', {
        decision: response.decision,
        confidence: response.confidence,
        reasoning: response.reasoning.substring(0, 100),
      });

      return response;
    } catch (error) {
      logger.error('Failed to generate AI decision', error);
      throw new AIError('AI decision generation failed', { error });
    }
  }

  /**
   * Gets decision from OpenAI
   */
  private async getOpenAIDecision(prompt: string): Promise<AIResponse> {
    if (!this.openaiClient) {
      throw new AIError('OpenAI client not initialized');
    }

    const completion = await this.openaiClient.chat.completions.create({
      model: config.ai.model,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert cryptocurrency trading AI. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: config.ai.temperature,
      max_tokens: config.ai.maxTokens,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new AIError('Empty response from OpenAI');
    }

    return this.parseAIResponse(content);
  }

  /**
   * Gets decision from DeepSeek
   */
  private async getDeepSeekDecision(prompt: string): Promise<AIResponse> {
    if (!this.deepseekClient) {
      throw new AIError('DeepSeek client not initialized');
    }

    try {
      const completion = await this.deepseekClient.chat.completions.create({
        model: config.ai.model,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert cryptocurrency trading AI. Always respond with valid JSON only in this exact format: {"decision": "BUY|SELL|HOLD", "confidence": 0.0-1.0, "reasoning": "explanation"}',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: config.ai.temperature,
        max_tokens: config.ai.maxTokens,
        // DeepSeek might not support response_format, try without it first
      });

      logger.debug('DeepSeek raw response', { 
        choices: completion.choices?.length,
        hasContent: !!completion.choices[0]?.message?.content 
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        logger.error('Empty DeepSeek response', { completion });
        throw new AIError('Empty response from DeepSeek');
      }

      return this.parseAIResponse(content);
    } catch (error: any) {
      logger.error('DeepSeek API error', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Gets decision from Anthropic Claude
   */
  private async getAnthropicDecision(prompt: string): Promise<AIResponse> {
    if (!this.anthropicClient) {
      throw new AIError('Anthropic client not initialized');
    }

    const message = await this.anthropicClient.messages.create({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens || 1024,
      temperature: config.ai.temperature,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      throw new AIError('Unexpected response type from Anthropic');
    }

    return this.parseAIResponse(content.text);
  }

  /**
   * Parses AI response text to AIResponse object
   */
  private parseAIResponse(text: string): AIResponse {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
      const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;

      const parsed = JSON.parse(jsonText.trim());

      return {
        decision: parsed.decision,
        confidence: parseFloat(parsed.confidence),
        reasoning: parsed.reasoning,
        suggestedPrice: parsed.suggestedPrice ? parseFloat(parsed.suggestedPrice) : undefined,
        suggestedQuantity: parsed.suggestedQuantity ? parseFloat(parsed.suggestedQuantity) : undefined,
        stopLoss: parsed.stopLoss ? parseFloat(parsed.stopLoss) : undefined,
        takeProfit: parsed.takeProfit ? parseFloat(parsed.takeProfit) : undefined,
      };
    } catch (error) {
      logger.error('Failed to parse AI response', error, { responseText: text });
      throw new AIError('Failed to parse AI response as JSON', { text });
    }
  }

  /**
   * Validates AI response
   */
  private validateAIResponse(response: AIResponse): void {
    if (!['BUY', 'SELL', 'HOLD'].includes(response.decision)) {
      throw new AIError(`Invalid decision: ${response.decision}`);
    }

    if (response.confidence < 0 || response.confidence > 1) {
      throw new AIError(`Invalid confidence: ${response.confidence}`);
    }

    if (!response.reasoning || response.reasoning.length < 10) {
      throw new AIError('Reasoning is too short or missing');
    }
  }

  /**
   * Generates a decision with retry logic
   */
  async generateDecisionWithRetry(
    context: AIPromptContext,
    maxRetries = AI_CONSTANTS.MAX_RETRIES
  ): Promise<AIResponse> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`AI decision attempt ${attempt}/${maxRetries}`);
        return await this.generateDecision(context);
      } catch (error) {
        lastError = error as Error;
        logger.warn(`AI decision attempt ${attempt} failed`, { error: lastError.message });

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new AIError('Max retries exceeded for AI decision generation', { lastError });
  }

  /**
   * Analyzes trading strategy performance
   */
  async analyzePerformance(trades: any[], metrics: any): Promise<string> {
    const prompt = `Analyze this trading performance:

Total Trades: ${trades.length}
Win Rate: ${(metrics.winRate * 100).toFixed(2)}%
Total P&L: $${metrics.totalPnL.toFixed(2)}
ROI: ${(metrics.roi * 100).toFixed(2)}%
Max Drawdown: ${metrics.maxDrawdown.toFixed(2)}%

Provide insights on:
1. Strategy effectiveness
2. Areas for improvement
3. Risk management recommendations
4. Market condition analysis

Keep response concise (max 200 words).`;

    try {
      if ((this.provider === 'openai' && this.openaiClient) || (this.provider === 'deepseek' && this.deepseekClient)) {
        const client = this.provider === 'openai' ? this.openaiClient : this.deepseekClient;
        const completion = await client!.chat.completions.create({
          model: config.ai.model,
          messages: [
            { role: 'system', content: 'You are a trading performance analyst.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 500,
        });

        return completion.choices[0]?.message?.content || 'No analysis available';
      } else if (this.provider === 'anthropic' && this.anthropicClient) {
        const message = await this.anthropicClient.messages.create({
          model: config.ai.model,
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        return content.type === 'text' ? content.text : 'No analysis available';
      }

      return 'AI provider not configured';
    } catch (error) {
      logger.error('Failed to generate performance analysis', error);
      return 'Performance analysis unavailable';
    }
  }
}

// Export singleton instance
export const aiEngine = new AIEngine();
export default aiEngine;
