export interface RailConfig {
  maxNotional: number | null;
  instrumentWhitelist: string[];
  maxPriceDeviationBps: number;
}

export interface TradeIntent {
  base: string;
  quote: string;
  qty: string;
  price: string;
}

export type RailResult = { ok: true } | { ok: false; reason: string };

/** Bounds an auto-signed trade against the operator's config rails. Runs BEFORE
 * any signing; a failure returns a reason and the caller signs nothing. Float
 * math is fine here (same as the desk's oracle). */
export function checkRails(intent: TradeIntent, referenceMid: string | null, rails: RailConfig): RailResult {
  if (rails.maxNotional === null) {
    return { ok: false, reason: "trading is disabled: set AGENT_MAX_NOTIONAL to enable auto-signed trades" };
  }
  const { instrumentWhitelist: wl } = rails;
  if (wl.length > 0) {
    const listed = (symbol: string): boolean => wl.some((s) => s.toLowerCase() === symbol.toLowerCase());
    if (!listed(intent.base)) return { ok: false, reason: `instrument ${intent.base} is not on AGENT_INSTRUMENT_WHITELIST` };
    if (!listed(intent.quote)) return { ok: false, reason: `instrument ${intent.quote} is not on AGENT_INSTRUMENT_WHITELIST` };
  }
  const qty = Number(intent.qty);
  const price = Number(intent.price);
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) {
    return { ok: false, reason: `bad qty/price: qty=${intent.qty} price=${intent.price}` };
  }
  const notional = qty * price;
  if (notional > rails.maxNotional) {
    return { ok: false, reason: `notional ${notional} ${intent.quote} exceeds AGENT_MAX_NOTIONAL ${rails.maxNotional}` };
  }
  const mid = referenceMid === null ? NaN : Number(referenceMid);
  if (!Number.isFinite(mid) || mid <= 0) {
    return { ok: false, reason: `no reference price for ${intent.base}/${intent.quote} — refusing (fail closed)` };
  }
  const deviationBps = (Math.abs(price - mid) / mid) * 10_000;
  if (deviationBps > rails.maxPriceDeviationBps) {
    return { ok: false, reason: `price ${intent.price} deviates ${Math.round(deviationBps)} bps from reference ${referenceMid}, over AGENT_MAX_PRICE_DEVIATION_BPS ${rails.maxPriceDeviationBps}` };
  }
  return { ok: true };
}
