import { buildStrategies50 } from './strategies.js';
import { backtestStrategy } from './backtest.js';

export function rankTop3({ klinesBySymbol, config }) {
  const strategies = buildStrategies50();
  const results = [];

  for (const [symbol, klines] of Object.entries(klinesBySymbol)) {
    for (const strat of strategies) {
      const r = backtestStrategy({
        strategy: strat,
        klines,
        atrPeriod: config.atrPeriod,
        atrMult: config.atrMult,
        takeProfitR: config.takeProfitR,
        timeStopCandles: config.timeStopCandles,
        feeBps: config.feeBps,
        minTrades: config.minTrades,
      });
      if (!r.ok) continue;
      results.push({ symbol, strategyId: strat.id, family: strat.family, params: strat.params, ...r });
    }
  }

  // Sort by expectancy, then profitFactor, then drawdown
  results.sort((a, b) => {
    if (b.expectancy !== a.expectancy) return b.expectancy - a.expectancy;
    if (b.profitFactor !== a.profitFactor) return b.profitFactor - a.profitFactor;
    return a.maxDD - b.maxDD;
  });

  return {
    strategiesTested: buildStrategies50().length,
    candidates: results.length,
    ranked: results,
    top3: results.slice(0, 3),
  };
}
