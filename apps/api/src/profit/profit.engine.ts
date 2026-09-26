/**
 * Net kâr motoru — tek kaynak.
 * net = gross - commission - shipping - serviceFee - vatNet - withholding - cost
 */
export type ProfitInput = {
  grossAmount: number;
  commission: number;
  shippingFee: number;
  serviceFee: number;
  vatNet: number;
  withholding: number;
  costTotal: number;
};

export type ProfitResult = ProfitInput & {
  netProfit: number;
  marginPct: number;
};

export function calculateNetProfit(input: ProfitInput): ProfitResult {
  const netProfit =
    input.grossAmount -
    input.commission -
    input.shippingFee -
    input.serviceFee -
    input.vatNet -
    input.withholding -
    input.costTotal;

  const marginPct =
    input.grossAmount > 0 ? (netProfit / input.grossAmount) * 100 : 0;

  return {
    ...input,
    netProfit: round2(netProfit),
    marginPct: round2(marginPct),
  };
}

/** Hedef marjdan önerilen satış fiyatı (ters hesap). */
export function suggestedSalePrice(params: {
  cost: number;
  commissionRate: number;
  shipping: number;
  serviceFee: number;
  vatNet: number;
  withholding: number;
  targetMarginPct: number;
}): number {
  const { cost, commissionRate, shipping, serviceFee, vatNet, withholding, targetMarginPct } =
    params;
  const fixed = cost + shipping + serviceFee + vatNet + withholding;
  const rate = commissionRate + targetMarginPct / 100;
  if (rate >= 1) return round2(fixed * 2);
  return round2(fixed / (1 - rate));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
