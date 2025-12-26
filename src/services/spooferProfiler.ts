import { logger } from '../core/logger';
import { SpoofingAlert } from './liquidityTracker';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SPOOFER PROFILER SERVICE
 * 
 * Anche se gli ordini sono anonimi, possiamo creare "fingerprint" comportamentali
 * per identificare pattern ricorrenti che probabilmente appartengono allo stesso spoofer.
 * 
 * Fingerprint basati su:
 * 1. Size patterns - ordini sempre di certe dimensioni (es: 5.0, 10.0 BTC)
 * 2. Price patterns - preferenza per certi livelli (rotondi, psicologici)
 * 3. Timing patterns - durata media prima della rimozione
 * 4. Distance patterns - sempre a certa distanza dal prezzo
 * 5. Side preference - preferisce BID o ASK spoofing
 * 6. Time of day - attivo in certi orari
 */

// ========================================
// TYPES
// ========================================

export interface SpooferFingerprint {
  id: string;                      // Hash unico del fingerprint
  firstSeen: number;
  lastSeen: number;
  totalOccurrences: number;
  
  // Pattern characteristics
  characteristics: {
    // Size pattern
    avgSize: number;
    sizeStdDev: number;
    preferredSizes: number[];      // Sizes che usa spesso
    
    // Price pattern  
    prefersRoundNumbers: boolean;  // Es: 87000, 87500
    avgDistancePercent: number;
    distanceRange: { min: number; max: number };
    
    // Timing pattern
    avgDurationMs: number;         // Quanto tiene l'ordine prima di rimuoverlo
    avgDisappearances: number;     // Quante volte sparisce/riappare
    
    // Side preference
    sidePreference: 'BID' | 'ASK' | 'BOTH';
    bidRatio: number;              // 0-1, quanto spesso usa BID
    
    // Activity pattern
    activeHours: number[];         // Ore UTC quando è più attivo
    avgAlertsPerSession: number;
  };
  
  // Confidence in this fingerprint
  confidence: number;              // 0-100
  reliability: number;             // Quanto sono affidabili i segnali di questo spoofer
  
  // Historical performance
  stats: {
    correctPredictions: number;    // Quante volte il prezzo si è mosso come previsto
    incorrectPredictions: number;
    avgProfitOnFollow: number;     // Profitto medio seguendo questo spoofer
  };
  
  // Recent activity
  recentAlerts: SpoofingAlert[];
  isCurrentlyActive: boolean;
}

export interface SpooferSession {
  startTime: number;
  endTime: number | null;
  alerts: SpoofingAlert[];
  fingerprint: SpooferFingerprint | null;
  predictedDirection: 'UP' | 'DOWN' | null;
  actualMovement: number | null;   // % movement after session
  wasCorrect: boolean | null;
}

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // Fingerprint matching thresholds
  SIZE_TOLERANCE: 0.15,            // 15% tolerance per size match
  DISTANCE_TOLERANCE: 0.1,         // 0.1% tolerance per distance
  MIN_OCCURRENCES_FOR_PROFILE: 5,  // Minimo alerts per creare profilo
  
  // Session detection
  SESSION_GAP_MS: 60000,           // Gap di 1 min = nuova sessione
  MIN_ALERTS_FOR_SESSION: 3,
  
  // Round number detection
  ROUND_NUMBER_THRESHOLD: 100,     // Considera "round" se divisibile per 100
  
  // Persistence
  DATA_FILE: 'logs/spoofer-profiles.json',
  SAVE_INTERVAL_MS: 60000,         // Salva ogni minuto
};

// ========================================
// SPOOFER PROFILER CLASS
// ========================================

class SpooferProfiler {
  private fingerprints: Map<string, SpooferFingerprint> = new Map();
  private activeSessions: Map<string, SpooferSession> = new Map();
  private alertBuffer: SpoofingAlert[] = [];
  private saveInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.loadProfiles();
  }
  
  /**
   * Start the profiler
   */
  start(): void {
    logger.info('[SpooferProfiler] Starting...');
    this.saveInterval = setInterval(() => this.saveProfiles(), CONFIG.SAVE_INTERVAL_MS);
  }
  
  /**
   * Stop the profiler
   */
  stop(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveProfiles();
    logger.info('[SpooferProfiler] Stopped');
  }
  
  /**
   * Process new spoofing alerts
   */
  processAlerts(alerts: SpoofingAlert[]): void {
    if (alerts.length === 0) return;
    
    // Add to buffer
    this.alertBuffer.push(...alerts);
    
    // Keep only recent alerts (last 5 minutes)
    const cutoff = Date.now() - 300000;
    this.alertBuffer = this.alertBuffer.filter(a => a.timestamp > cutoff);
    
    // Try to match alerts to existing fingerprints or create new ones
    for (const alert of alerts) {
      this.processAlert(alert);
    }
    
    // Update active sessions
    this.updateSessions();
  }
  
  /**
   * Process a single alert
   */
  private processAlert(alert: SpoofingAlert): void {
    // Find matching fingerprint
    const matchingFingerprint = this.findMatchingFingerprint(alert);
    
    if (matchingFingerprint) {
      // Update existing fingerprint
      this.updateFingerprint(matchingFingerprint, alert);
    } else {
      // Check if we have enough similar alerts to create a new fingerprint
      const similarAlerts = this.findSimilarAlerts(alert);
      if (similarAlerts.length >= CONFIG.MIN_OCCURRENCES_FOR_PROFILE) {
        this.createFingerprint(similarAlerts);
      }
    }
  }
  
  /**
   * Find a fingerprint that matches this alert
   */
  private findMatchingFingerprint(alert: SpoofingAlert): SpooferFingerprint | null {
    for (const fp of this.fingerprints.values()) {
      const score = this.calculateMatchScore(fp, alert);
      if (score > 70) {  // 70% match threshold
        return fp;
      }
    }
    return null;
  }
  
  /**
   * Calculate how well an alert matches a fingerprint (0-100)
   */
  private calculateMatchScore(fp: SpooferFingerprint, alert: SpoofingAlert): number {
    let score = 0;
    let factors = 0;
    
    // Size match (30 points)
    const sizeDiff = Math.abs(alert.originalSize - fp.characteristics.avgSize) / fp.characteristics.avgSize;
    if (sizeDiff <= CONFIG.SIZE_TOLERANCE) {
      score += 30 * (1 - sizeDiff / CONFIG.SIZE_TOLERANCE);
    }
    factors++;
    
    // Side preference match (20 points)
    if (fp.characteristics.sidePreference === alert.side || 
        fp.characteristics.sidePreference === 'BOTH') {
      score += 20;
    }
    factors++;
    
    // Round number pattern match (15 points)
    const isRound = alert.priceLevel % CONFIG.ROUND_NUMBER_THRESHOLD === 0;
    if (isRound === fp.characteristics.prefersRoundNumbers) {
      score += 15;
    }
    factors++;
    
    // Recent activity bonus (15 points)
    const timeSinceLastSeen = Date.now() - fp.lastSeen;
    if (timeSinceLastSeen < 300000) {  // Active in last 5 min
      score += 15;
    } else if (timeSinceLastSeen < 3600000) {  // Active in last hour
      score += 10;
    }
    factors++;
    
    // Hour of day match (10 points)
    const currentHour = new Date().getUTCHours();
    if (fp.characteristics.activeHours.includes(currentHour)) {
      score += 10;
    }
    factors++;
    
    // Preferred size match (10 points)
    const nearPreferredSize = fp.characteristics.preferredSizes.some(
      ps => Math.abs(ps - alert.originalSize) / ps < CONFIG.SIZE_TOLERANCE
    );
    if (nearPreferredSize) {
      score += 10;
    }
    factors++;
    
    return score;
  }
  
  /**
   * Find alerts similar to this one
   */
  private findSimilarAlerts(alert: SpoofingAlert): SpoofingAlert[] {
    return this.alertBuffer.filter(a => {
      // Same side
      if (a.side !== alert.side) return false;
      
      // Similar size (within 30%)
      const sizeDiff = Math.abs(a.originalSize - alert.originalSize) / alert.originalSize;
      if (sizeDiff > 0.3) return false;
      
      // Similar price pattern (both round or both not)
      const aIsRound = a.priceLevel % CONFIG.ROUND_NUMBER_THRESHOLD === 0;
      const alertIsRound = alert.priceLevel % CONFIG.ROUND_NUMBER_THRESHOLD === 0;
      if (aIsRound !== alertIsRound) return false;
      
      return true;
    });
  }
  
  /**
   * Create a new fingerprint from similar alerts
   */
  private createFingerprint(alerts: SpoofingAlert[]): void {
    const sizes = alerts.map(a => a.originalSize);
    const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const sizeStdDev = Math.sqrt(
      sizes.reduce((sum, s) => sum + Math.pow(s - avgSize, 2), 0) / sizes.length
    );
    
    // Calculate preferred sizes (most common)
    const sizeCount = new Map<number, number>();
    for (const size of sizes) {
      const rounded = Math.round(size * 10) / 10;  // Round to 0.1
      sizeCount.set(rounded, (sizeCount.get(rounded) || 0) + 1);
    }
    const preferredSizes = Array.from(sizeCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);
    
    // Calculate side preference
    const bidCount = alerts.filter(a => a.side === 'BID').length;
    const bidRatio = bidCount / alerts.length;
    const sidePreference = bidRatio > 0.7 ? 'BID' : bidRatio < 0.3 ? 'ASK' : 'BOTH';
    
    // Check round number preference
    const roundCount = alerts.filter(a => a.priceLevel % CONFIG.ROUND_NUMBER_THRESHOLD === 0).length;
    const prefersRoundNumbers = roundCount / alerts.length > 0.5;
    
    // Active hours
    const hourCount = new Map<number, number>();
    for (const alert of alerts) {
      const hour = new Date(alert.timestamp).getUTCHours();
      hourCount.set(hour, (hourCount.get(hour) || 0) + 1);
    }
    const activeHours = Array.from(hourCount.entries())
      .filter(e => e[1] >= 2)  // At least 2 occurrences
      .map(e => e[0]);
    
    // Generate unique ID based on characteristics
    const id = this.generateFingerprintId(avgSize, sidePreference, prefersRoundNumbers);
    
    const fingerprint: SpooferFingerprint = {
      id,
      firstSeen: Math.min(...alerts.map(a => a.timestamp)),
      lastSeen: Math.max(...alerts.map(a => a.timestamp)),
      totalOccurrences: alerts.length,
      characteristics: {
        avgSize,
        sizeStdDev,
        preferredSizes,
        prefersRoundNumbers,
        avgDistancePercent: 0,  // Will be updated
        distanceRange: { min: 0, max: 0 },
        avgDurationMs: 0,
        avgDisappearances: alerts.reduce((sum, a) => sum + (a.confidence / 10), 0) / alerts.length,
        sidePreference,
        bidRatio,
        activeHours,
        avgAlertsPerSession: alerts.length,
      },
      confidence: Math.min(95, 50 + alerts.length * 5),
      reliability: 50,  // Start at 50%, will be updated based on performance
      stats: {
        correctPredictions: 0,
        incorrectPredictions: 0,
        avgProfitOnFollow: 0,
      },
      recentAlerts: alerts.slice(-10),
      isCurrentlyActive: true,
    };
    
    this.fingerprints.set(id, fingerprint);
    
    logger.info(`🔍 [SpooferProfiler] NEW SPOOFER IDENTIFIED`, {
      id: id.substring(0, 8),
      avgSize: avgSize.toFixed(2),
      sidePreference,
      prefersRoundNumbers,
      confidence: fingerprint.confidence,
      alertCount: alerts.length,
    });
  }
  
  /**
   * Update an existing fingerprint with new alert
   */
  private updateFingerprint(fp: SpooferFingerprint, alert: SpoofingAlert): void {
    fp.lastSeen = alert.timestamp;
    fp.totalOccurrences++;
    fp.isCurrentlyActive = true;
    
    // Update recent alerts
    fp.recentAlerts.push(alert);
    if (fp.recentAlerts.length > 20) {
      fp.recentAlerts.shift();
    }
    
    // Update running averages
    const n = fp.totalOccurrences;
    fp.characteristics.avgSize = (fp.characteristics.avgSize * (n - 1) + alert.originalSize) / n;
    
    // Update bid ratio
    if (alert.side === 'BID') {
      fp.characteristics.bidRatio = (fp.characteristics.bidRatio * (n - 1) + 1) / n;
    } else {
      fp.characteristics.bidRatio = (fp.characteristics.bidRatio * (n - 1)) / n;
    }
    
    // Update side preference
    if (fp.characteristics.bidRatio > 0.7) {
      fp.characteristics.sidePreference = 'BID';
    } else if (fp.characteristics.bidRatio < 0.3) {
      fp.characteristics.sidePreference = 'ASK';
    } else {
      fp.characteristics.sidePreference = 'BOTH';
    }
    
    // Update active hours
    const hour = new Date(alert.timestamp).getUTCHours();
    if (!fp.characteristics.activeHours.includes(hour)) {
      fp.characteristics.activeHours.push(hour);
    }
    
    // Increase confidence with more occurrences
    fp.confidence = Math.min(95, fp.confidence + 1);
    
    logger.debug(`🔍 [SpooferProfiler] Updated fingerprint ${fp.id.substring(0, 8)}`, {
      totalOccurrences: fp.totalOccurrences,
      confidence: fp.confidence,
    });
  }
  
  /**
   * Generate unique fingerprint ID
   */
  private generateFingerprintId(avgSize: number, side: string, prefersRound: boolean): string {
    const sizeGroup = Math.floor(avgSize * 10);  // Group by 0.1 BTC
    const hash = `SP-${side[0]}${prefersRound ? 'R' : 'N'}-${sizeGroup}-${Date.now().toString(36)}`;
    return hash;
  }
  
  /**
   * Update active sessions
   */
  private updateSessions(): void {
    const now = Date.now();
    
    // Close stale sessions
    for (const [id, session] of this.activeSessions) {
      const lastAlert = session.alerts[session.alerts.length - 1];
      if (now - lastAlert.timestamp > CONFIG.SESSION_GAP_MS) {
        session.endTime = lastAlert.timestamp;
        // TODO: Track actual price movement after session ends
        this.activeSessions.delete(id);
        
        logger.info(`📊 [SpooferProfiler] Session ended for ${id.substring(0, 8)}`, {
          duration: ((session.endTime - session.startTime) / 1000).toFixed(0) + 's',
          alertCount: session.alerts.length,
        });
      }
    }
    
    // Mark fingerprints as inactive if no recent activity
    for (const fp of this.fingerprints.values()) {
      if (now - fp.lastSeen > CONFIG.SESSION_GAP_MS * 2) {
        fp.isCurrentlyActive = false;
      }
    }
  }
  
  /**
   * Get currently active spoofers
   */
  getActiveSpoofers(): SpooferFingerprint[] {
    return Array.from(this.fingerprints.values())
      .filter(fp => fp.isCurrentlyActive)
      .sort((a, b) => b.confidence - a.confidence);
  }
  
  /**
   * Get all known spoofer profiles
   */
  getAllProfiles(): SpooferFingerprint[] {
    return Array.from(this.fingerprints.values())
      .sort((a, b) => b.totalOccurrences - a.totalOccurrences);
  }
  
  /**
   * Get spoofer statistics
   */
  getStats(): {
    totalProfiles: number;
    activeNow: number;
    mostActiveSpoofer: SpooferFingerprint | null;
    totalAlertsTracked: number;
    avgReliability: number;
  } {
    const profiles = Array.from(this.fingerprints.values());
    const active = profiles.filter(p => p.isCurrentlyActive);
    const mostActive = profiles.sort((a, b) => b.totalOccurrences - a.totalOccurrences)[0] || null;
    const avgReliability = profiles.length > 0
      ? profiles.reduce((sum, p) => sum + p.reliability, 0) / profiles.length
      : 0;
    
    return {
      totalProfiles: profiles.length,
      activeNow: active.length,
      mostActiveSpoofer: mostActive,
      totalAlertsTracked: profiles.reduce((sum, p) => sum + p.totalOccurrences, 0),
      avgReliability: Math.round(avgReliability),
    };
  }
  
  /**
   * Get trading recommendation based on active spoofers
   */
  getSpooferBasedSignal(): {
    action: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    reasoning: string;
    activeSpoofers: {
      id: string;
      side: string;
      reliability: number;
      alertCount: number;
    }[];
  } {
    const activeSpoofers = this.getActiveSpoofers();
    
    if (activeSpoofers.length === 0) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: 'No known spoofers currently active',
        activeSpoofers: [],
      };
    }
    
    // Weight by reliability and recent activity
    let bidWeight = 0;
    let askWeight = 0;
    
    for (const spoofer of activeSpoofers) {
      const weight = (spoofer.reliability / 100) * (spoofer.confidence / 100) * spoofer.recentAlerts.length;
      
      if (spoofer.characteristics.sidePreference === 'BID') {
        // BID spoofer = fake support = will dump = SELL
        askWeight += weight;
      } else if (spoofer.characteristics.sidePreference === 'ASK') {
        // ASK spoofer = fake resistance = will pump = BUY
        bidWeight += weight;
      } else {
        // BOTH - use recent alerts
        const recentBid = spoofer.recentAlerts.filter(a => a.side === 'BID').length;
        const recentAsk = spoofer.recentAlerts.filter(a => a.side === 'ASK').length;
        if (recentBid > recentAsk) {
          askWeight += weight * 0.5;
        } else {
          bidWeight += weight * 0.5;
        }
      }
    }
    
    const totalWeight = bidWeight + askWeight;
    if (totalWeight < 1) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: 'Insufficient spoofer activity weight',
        activeSpoofers: activeSpoofers.map(s => ({
          id: s.id.substring(0, 8),
          side: s.characteristics.sidePreference,
          reliability: s.reliability,
          alertCount: s.recentAlerts.length,
        })),
      };
    }
    
    const bidRatio = bidWeight / totalWeight;
    let action: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
    let reasoning = '';
    
    if (bidRatio > 0.65) {
      action = 'BUY';
      reasoning = `🎯 Known ASK spoofers active (${(bidRatio * 100).toFixed(0)}% weight) - expect pump`;
    } else if (bidRatio < 0.35) {
      action = 'SELL';
      reasoning = `🎯 Known BID spoofers active (${((1 - bidRatio) * 100).toFixed(0)}% weight) - expect dump`;
    } else {
      reasoning = `Mixed spoofer activity (BID: ${((1 - bidRatio) * 100).toFixed(0)}%, ASK: ${(bidRatio * 100).toFixed(0)}%)`;
    }
    
    // Confidence based on spoofer reliability and weight
    const avgReliability = activeSpoofers.reduce((sum, s) => sum + s.reliability, 0) / activeSpoofers.length;
    const confidence = action !== 'WAIT' 
      ? Math.min(90, avgReliability * Math.abs(bidRatio - 0.5) * 2 * 1.5)
      : 0;
    
    return {
      action,
      confidence: Math.round(confidence),
      reasoning,
      activeSpoofers: activeSpoofers.map(s => ({
        id: s.id.substring(0, 8),
        side: s.characteristics.sidePreference,
        reliability: s.reliability,
        alertCount: s.recentAlerts.length,
      })),
    };
  }
  
  /**
   * Record prediction outcome to improve reliability scores
   */
  recordOutcome(fingerprints: string[], predictedDirection: 'UP' | 'DOWN', actualMovement: number): void {
    const wasCorrect = (predictedDirection === 'UP' && actualMovement > 0) ||
                       (predictedDirection === 'DOWN' && actualMovement < 0);
    
    for (const fpId of fingerprints) {
      const fp = this.fingerprints.get(fpId);
      if (fp) {
        if (wasCorrect) {
          fp.stats.correctPredictions++;
          fp.reliability = Math.min(95, fp.reliability + 2);
        } else {
          fp.stats.incorrectPredictions++;
          fp.reliability = Math.max(10, fp.reliability - 3);
        }
        
        // Update average profit
        const totalPredictions = fp.stats.correctPredictions + fp.stats.incorrectPredictions;
        fp.stats.avgProfitOnFollow = (fp.stats.avgProfitOnFollow * (totalPredictions - 1) + actualMovement) / totalPredictions;
        
        logger.info(`📊 [SpooferProfiler] Outcome recorded for ${fpId.substring(0, 8)}`, {
          wasCorrect,
          newReliability: fp.reliability,
          winRate: ((fp.stats.correctPredictions / totalPredictions) * 100).toFixed(0) + '%',
        });
      }
    }
    
    this.saveProfiles();
  }
  
  /**
   * Save profiles to disk
   */
  private saveProfiles(): void {
    try {
      const dataDir = path.dirname(CONFIG.DATA_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      const data = {
        version: 1,
        savedAt: Date.now(),
        fingerprints: Array.from(this.fingerprints.entries()),
      };
      
      fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
      logger.debug(`[SpooferProfiler] Saved ${this.fingerprints.size} profiles`);
    } catch (error) {
      logger.error('[SpooferProfiler] Error saving profiles', error);
    }
  }
  
  /**
   * Load profiles from disk
   */
  private loadProfiles(): void {
    try {
      if (fs.existsSync(CONFIG.DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf-8'));
        this.fingerprints = new Map(data.fingerprints);
        
        // Mark all as inactive on load
        for (const fp of this.fingerprints.values()) {
          fp.isCurrentlyActive = false;
          fp.recentAlerts = [];  // Clear old alerts
        }
        
        logger.info(`[SpooferProfiler] Loaded ${this.fingerprints.size} profiles from disk`);
      }
    } catch (error) {
      logger.error('[SpooferProfiler] Error loading profiles', error);
    }
  }
}

export const spooferProfiler = new SpooferProfiler();
export default spooferProfiler;
