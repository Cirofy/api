import type { MarketplaceCode } from "./marketplace.types";

export type PulledAdSpend = {
  sku: string;
  title: string;
  marketplace: MarketplaceCode;
  adSpend: number;
  attributedSales: number;
  orders: number;
  influencerFee: number;
  netAfterAds: number;
};

export type PartnerAdsValidation = {
  ok: boolean;
  rowCount: number;
  mappedCount: number;
  skipped: number;
  issues: string[];
  sampleSkus: string[];
};

/** Partner reklam JSON → Cirofy harcama satırları */
export function mapPartnerAdsPayload(
  code: MarketplaceCode,
  json: unknown,
): PulledAdSpend[] | null {
  const result = mapAndValidatePartnerAds(code, json);
  return result.rows.length > 0 ? result.rows : null;
}

/** Eşleme + şema doğrulama özeti (canlı yanıt testi için) */
export function mapAndValidatePartnerAds(
  code: MarketplaceCode,
  json: unknown,
): { rows: PulledAdSpend[]; validation: PartnerAdsValidation } {
  const issues: string[] = [];
  const rowsRaw = extractRows(json, [
    "content",
    "items",
    "ads",
    "campaigns",
    "data",
    "result",
    "reports",
    "rows",
    "list",
  ]);

  if (!rowsRaw) {
    issues.push("Yanıtta satır dizisi bulunamadı");
    return {
      rows: [],
      validation: {
        ok: false,
        rowCount: 0,
        mappedCount: 0,
        skipped: 0,
        issues,
        sampleSkus: [],
      },
    };
  }

  if (rowsRaw.length === 0) {
    issues.push("Satır dizisi boş");
  }

  const mapped: PulledAdSpend[] = [];
  let skipped = 0;

  for (let i = 0; i < Math.min(rowsRaw.length, 200); i++) {
    const row = rowsRaw[i]!;
    const item = mapAdRow(code, row, i);
    if (!item) {
      skipped += 1;
      if (skipped <= 3) {
        issues.push(`Satır ${i + 1}: harcama/satış alanı okunamadı`);
      }
      continue;
    }
    mapped.push(item);
  }

  if (mapped.length === 0 && rowsRaw.length > 0) {
    issues.push("Hiçbir satır eşlenemedi — alan adlarını kontrol edin");
  }

  const totalSpend = mapped.reduce((s, r) => s + r.adSpend, 0);
  const totalSales = mapped.reduce((s, r) => s + r.attributedSales, 0);
  if (mapped.length > 0 && totalSpend === 0 && totalSales === 0) {
    issues.push("Eşlenen satırlarda harcama ve satış sıfır");
  }

  return {
    rows: mapped,
    validation: {
      ok: mapped.length > 0 && issues.filter((i) => !i.startsWith("Satır")).length === 0,
      rowCount: rowsRaw.length,
      mappedCount: mapped.length,
      skipped,
      issues: issues.slice(0, 8),
      sampleSkus: mapped.slice(0, 5).map((r) => r.sku),
    },
  };
}

function mapAdRow(
  code: MarketplaceCode,
  row: Record<string, unknown>,
  index: number,
): PulledAdSpend | null {
  const nested = nestedMetrics(row);

  const sku =
    firstString(row, [
      "sku",
      "stockCode",
      "merchantSku",
      "productSku",
      "barcode",
      "productCode",
      "advertiserProductId",
    ]) ?? `SKU-AD-${index + 1}`;

  const title =
    firstString(row, [
      "title",
      "productName",
      "name",
      "campaignName",
      "adGroupName",
      "productTitle",
    ]) ?? "Reklam satırı";

  const adSpend =
    firstNumber(row, [
      "adSpend",
      "spend",
      "cost",
      "advertisingCost",
      "totalSpend",
      "amount",
      "budgetSpent",
      "clickCost",
      "mediaCost",
    ]) ??
    firstNumber(nested, ["spend", "cost", "adSpend", "amount"]) ??
    0;

  const attributedSales =
    firstNumber(row, [
      "attributedSales",
      "sales",
      "revenue",
      "gmv",
      "turnover",
      "saleAmount",
      "directSales",
      "indirectSales",
    ]) ??
    firstNumber(nested, ["sales", "revenue", "gmv", "attributedSales"]) ??
    0;

  const orders =
    firstNumber(row, [
      "orders",
      "orderCount",
      "conversions",
      "units",
      "soldQuantity",
      "attributionOrders",
    ]) ??
    firstNumber(nested, ["orders", "conversions", "units"]) ??
    0;

  const influencerFee =
    firstNumber(row, [
      "influencerFee",
      "influencerCost",
      "creatorFee",
      "collabFee",
      "affiliateFee",
    ]) ?? 0;

  const netFromPartner = firstNumber(row, [
    "netAfterAds",
    "netProfit",
    "profit",
    "contribution",
  ]);
  const netAfterAds =
    netFromPartner ?? attributedSales * 0.18 - adSpend - influencerFee;

  if (adSpend <= 0 && attributedSales <= 0) return null;

  return {
    sku,
    title,
    marketplace: code,
    adSpend,
    attributedSales,
    orders,
    influencerFee,
    netAfterAds: Math.round(netAfterAds * 100) / 100,
  };
}

/** metrics / performance / summary alt nesnesi */
function nestedMetrics(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["metrics", "performance", "summary", "stats", "totals"]) {
    const v = row[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return {};
}

function extractRows(
  json: unknown,
  keys: string[],
): Record<string, unknown>[] | null {
  if (Array.isArray(json)) return json.filter(isRecord);
  if (!isRecord(json)) return null;
  for (const key of keys) {
    const nested = json[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
    if (isRecord(nested)) {
      for (const inner of keys) {
        const arr = nested[inner];
        if (Array.isArray(arr)) return arr.filter(isRecord);
      }
    }
  }
  return null;
}

function firstString(row: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function firstNumber(row: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v.replace(",", ".").replace(/[^\d.-]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
