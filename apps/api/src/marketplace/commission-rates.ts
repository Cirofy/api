import type { MarketplaceCode } from "./marketplace.types";

/** Partner komisyon çekimi — kategori/SKU bazlı oran. */
export type PulledCommissionRate = {
  marketplace: MarketplaceCode;
  /** Kategori etiketi (yoksa "Diğer") */
  category: string;
  /** 0–1 arası oran */
  rate: number;
  /** Plus / üst bant — yoksa rate ile aynı */
  plusRate: number;
  sku?: string | null;
  barcode?: string | null;
  note?: string;
};

export function normalizeCommissionRate(raw: number): number | null {
  if (!Number.isFinite(raw) || raw < 0) return null;
  // Partner çoğu zaman yüzde verir (12.5); bazen 0–1
  const rate = raw > 1 ? raw / 100 : raw;
  if (rate <= 0 || rate > 0.8) return null;
  return Math.round(rate * 10000) / 10000;
}

export function medianRate(rates: number[]): number {
  if (rates.length === 0) return 0;
  const sorted = [...rates].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/** SKU satırlarından kategori tarifesi üret. */
export function aggregateByCategory(
  rows: PulledCommissionRate[],
): Map<
  string,
  {
    marketplace: MarketplaceCode;
    category: string;
    rate: number;
    plusRate: number;
    sampleCount: number;
    note: string;
  }
> {
  const buckets = new Map<
    string,
    { marketplace: MarketplaceCode; category: string; rates: number[]; plusRates: number[] }
  >();

  for (const row of rows) {
    const category = (row.category || "Diğer").trim() || "Diğer";
    const key = `${row.marketplace}::${category.toLowerCase()}`;
    const cur = buckets.get(key) ?? {
      marketplace: row.marketplace,
      category,
      rates: [],
      plusRates: [],
    };
    cur.rates.push(row.rate);
    cur.plusRates.push(row.plusRate > 0 ? row.plusRate : row.rate);
    buckets.set(key, cur);
  }

  const out = new Map<
    string,
    {
      marketplace: MarketplaceCode;
      category: string;
      rate: number;
      plusRate: number;
      sampleCount: number;
      note: string;
    }
  >();

  for (const [key, b] of buckets) {
    const rate = medianRate(b.rates);
    const plusRate = Math.max(rate, medianRate(b.plusRates));
    out.set(key, {
      marketplace: b.marketplace,
      category: b.category,
      rate,
      plusRate,
      sampleCount: b.rates.length,
      note: `Canlı çekim · ${b.rates.length} örnek · medyan`,
    });
  }

  return out;
}

/** Barkod bazlı medyan oran (aynı barkod birden fazla Sale satırında gelebilir). */
export function aggregateByBarcode(
  rows: PulledCommissionRate[],
): Map<
  string,
  {
    marketplace: MarketplaceCode;
    barcode: string;
    rate: number;
    plusRate: number;
    sampleCount: number;
  }
> {
  const buckets = new Map<
    string,
    { marketplace: MarketplaceCode; barcode: string; rates: number[]; plusRates: number[] }
  >();

  for (const row of rows) {
    const barcode = row.barcode?.trim();
    if (!barcode) continue;
    const key = `${row.marketplace}::${barcode}`;
    const cur = buckets.get(key) ?? {
      marketplace: row.marketplace,
      barcode,
      rates: [],
      plusRates: [],
    };
    cur.rates.push(row.rate);
    cur.plusRates.push(row.plusRate > 0 ? row.plusRate : row.rate);
    buckets.set(key, cur);
  }

  const out = new Map<
    string,
    {
      marketplace: MarketplaceCode;
      barcode: string;
      rate: number;
      plusRate: number;
      sampleCount: number;
    }
  >();

  for (const [key, b] of buckets) {
    const rate = medianRate(b.rates);
    out.set(key, {
      marketplace: b.marketplace,
      barcode: b.barcode,
      rate,
      plusRate: Math.max(rate, medianRate(b.plusRates)),
      sampleCount: b.rates.length,
    });
  }

  return out;
}

/** Barkod oranlarını ürün markasına bağlayıp marka medyanı üretir. */
export function aggregateByBrand(
  barcodeRates: Array<{
    marketplace: MarketplaceCode;
    barcode: string;
    rate: number;
    plusRate: number;
    sampleCount?: number;
  }>,
  barcodeToBrand: Map<string, string>,
): Map<
  string,
  {
    marketplace: MarketplaceCode;
    brand: string;
    rate: number;
    plusRate: number;
    sampleCount: number;
  }
> {
  const buckets = new Map<
    string,
    { marketplace: MarketplaceCode; brand: string; rates: number[]; plusRates: number[] }
  >();

  for (const row of barcodeRates) {
    const brand = barcodeToBrand.get(row.barcode)?.trim();
    if (!brand) continue;
    const key = `${row.marketplace}::${brand.toLowerCase()}`;
    const cur = buckets.get(key) ?? {
      marketplace: row.marketplace,
      brand,
      rates: [],
      plusRates: [],
    };
    // Örnek sayısı kadar ağırlık (tek aykırı satır medyanı bozmasın)
    const weight = Math.max(1, row.sampleCount ?? 1);
    for (let i = 0; i < weight; i += 1) {
      cur.rates.push(row.rate);
      cur.plusRates.push(row.plusRate > 0 ? row.plusRate : row.rate);
    }
    buckets.set(key, cur);
  }

  const out = new Map<
    string,
    {
      marketplace: MarketplaceCode;
      brand: string;
      rate: number;
      plusRate: number;
      sampleCount: number;
    }
  >();

  for (const [key, b] of buckets) {
    // En az 2 hakediş örneği olmadan marka oranı önerme
    if (b.rates.length < 2) continue;
    const rate = medianRate(b.rates);
    out.set(key, {
      marketplace: b.marketplace,
      brand: b.brand,
      rate,
      plusRate: Math.max(rate, medianRate(b.plusRates)),
      sampleCount: b.rates.length,
    });
  }

  return out;
}
