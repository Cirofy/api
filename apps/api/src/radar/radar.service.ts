import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TariffsService } from "../tariffs/tariffs.service";
import type { UpdateRadarPrefsDto } from "./dto";

export type RadarPrefs = {
  priceDropPctThreshold: number;
  stockAlertEnabled: boolean;
  updatedAt: string;
};

@Injectable()
export class RadarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  async getPrefs(organizationId: string): Promise<RadarPrefs> {
    const row = await this.prisma.radarPref.findUnique({
      where: { organizationId },
    });
    if (!row) {
      return {
        priceDropPctThreshold: 3,
        stockAlertEnabled: true,
        updatedAt: new Date(0).toISOString(),
      };
    }
    return {
      priceDropPctThreshold: Number(row.priceDropPctThreshold),
      stockAlertEnabled: row.stockAlertEnabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async savePrefs(
    organizationId: string,
    dto: UpdateRadarPrefsDto,
  ): Promise<RadarPrefs> {
    const threshold = Math.max(0, Math.min(50, dto.priceDropPctThreshold));
    const row = await this.prisma.radarPref.upsert({
      where: { organizationId },
      create: {
        organizationId,
        priceDropPctThreshold: threshold,
        stockAlertEnabled: dto.stockAlertEnabled,
      },
      update: {
        priceDropPctThreshold: threshold,
        stockAlertEnabled: dto.stockAlertEnabled,
      },
    });
    return {
      priceDropPctThreshold: Number(row.priceDropPctThreshold),
      stockAlertEnabled: row.stockAlertEnabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async overview(organizationId: string) {
    const prefs = await this.getPrefs(organizationId);
    const [stores, products, mismatches] = await Promise.all([
      this.prisma.store.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          marketplace: true,
          _count: { select: { products: true } },
        },
      }),
      this.prisma.product.findMany({
        where: { organizationId, isActive: true },
        orderBy: { updatedAt: "desc" },
        take: 40,
        select: {
          id: true,
          title: true,
          sku: true,
          brand: true,
          salePrice: true,
          stockQty: true,
          store: { select: { marketplace: true } },
        },
      }),
      this.tariffs.listMismatches(organizationId, 80).catch(() => ({
        items: [] as Array<{
          productId: string;
          sku: string | null;
          title: string;
          deltaPct: number;
          currentRatePct: number;
          suggestedRatePct: number;
        }>,
        total: 0,
      })),
    ]);

    const mismatchById = new Map(
      (mismatches.items ?? []).map((m) => [m.productId, m] as const),
    );

    const trackedStores = buildTrackedStores(stores);
    const trackedProducts = buildTrackedProducts(products, prefs, mismatchById);
    const ads: Array<{
      id: string;
      keyword: string;
      marketplace: string;
      competitors: number;
      ourBidHint: string;
      note: string;
    }> = [];
    const influencers: Array<{
      id: string;
      handle: string;
      platform: string;
      productHint: string;
      reach: string;
      note: string;
    }> = [];

    const tariffMismatchCount = mismatches.items?.length ?? 0;
    const tariffRiskScore = scoreTariffRisk(tariffMismatchCount, mismatches.items ?? []);

    const alerts = [
      ...buildTariffAlerts(mismatches.items ?? [], tariffRiskScore),
      ...buildCompetitorAlerts(trackedProducts),
    ];
    const alertCount = alerts.length;

    const hasCatalog = products.length > 0 || stores.length > 0;

    return {
      trackedStores,
      trackedProducts,
      ads,
      influencers,
      alerts,
      alertCount,
      tariffRiskScore,
      tariffMismatchCount,
      prefs,
      source: hasCatalog ? ("catalog" as const) : ("empty" as const),
      note: hasCatalog
        ? `Katalog sinyalleri · tarife risk ${tariffRiskScore}/100 · ${alertCount} uyarı. Rakip fiyat yakalaması yok.`
        : "Senkron sonrası katalog sinyalleri görünür; rakip fiyat için buybox yakalaması gerekir.",
    };
  }
}

function buildTrackedStores(
  stores: Array<{
    id: string;
    name: string;
    marketplace: string;
    _count: { products: number };
  }>,
) {
  return stores.map((s) => ({
    id: s.id,
    name: s.name,
    marketplace: s.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
    productCount: s._count.products,
    changeKind: "stable" as const,
    changeLabel: s._count.products > 0 ? "Katalog güncel" : "Ürün bekleniyor",
    affectedCount: 0,
    lastChange: s._count.products > 0 ? "Katalog güncel" : "Ürün bekleniyor",
    priceDropPct: 0,
    alert: false,
  }));
}

function buildTrackedProducts(
  products: Array<{
    id: string;
    title: string;
    sku: string | null;
    salePrice: unknown;
    stockQty: number | null;
    store: { marketplace: string };
  }>,
  prefs: RadarPrefs,
  mismatchById: Map<
    string,
    {
      productId: string;
      deltaPct: number;
      currentRatePct: number;
      suggestedRatePct: number;
    }
  >,
) {
  return products.slice(0, 12).map((p) => {
    const price = Number(p.salePrice);
    const currentPrice = round2(price);
    const prevPrice = round2(price);
    const stockQty = p.stockQty;
    const stock =
      stockQty == null ? "Var" : stockQty <= 0 ? "Yok" : stockQty <= 5 ? "Az" : "Var";

    const mm = mismatchById.get(p.id);
    const tariffDeltaPct = mm ? round2(Math.abs(mm.deltaPct)) : 0;
    const tariffRiskScore = mm
      ? Math.min(100, Math.round(40 + tariffDeltaPct * 12 + (mm.deltaPct > 2 ? 15 : 0)))
      : 0;

    let alert: string | null = null;
    if (mm && tariffRiskScore >= 55) {
      alert = `Tarife sapması Δ${tariffDeltaPct} puan`;
    } else if (prefs.stockAlertEnabled && stock === "Az") {
      alert = "Stok azaldı";
    } else if (prefs.stockAlertEnabled && stock === "Yok") {
      alert = "Stok tükendi";
    }

    return {
      id: p.id,
      title: p.title,
      sku: p.sku,
      marketplace:
        p.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
      price: currentPrice,
      prevPrice,
      priceDropPct: 0,
      stock,
      alert,
      tariffMismatch: Boolean(mm),
      tariffDeltaPct: mm ? round2(mm.deltaPct) : null,
      tariffRiskScore,
      currentRatePct: mm?.currentRatePct ?? null,
      suggestedRatePct: mm?.suggestedRatePct ?? null,
    };
  });
}

type AlertSeverity = "critical" | "warn" | "info";

function scoreTariffRisk(
  count: number,
  items: Array<{ deltaPct: number }>,
): number {
  if (count <= 0) return 0;
  const avgAbs =
    items.reduce((s, i) => s + Math.abs(i.deltaPct), 0) / Math.max(1, items.length);
  const fromCount = Math.min(55, count * 6);
  const fromDelta = Math.min(45, Math.round(avgAbs * 10));
  return Math.min(100, fromCount + fromDelta);
}

function buildTariffAlerts(
  items: Array<{
    productId: string;
    sku: string | null;
    title: string;
    deltaPct: number;
    currentRatePct: number;
    suggestedRatePct: number;
  }>,
  portfolioRisk: number,
) {
  const alerts: Array<{
    id: string;
    severity: AlertSeverity;
    kind: "tariff_mismatch";
    title: string;
    detail: string;
    marketplace: string;
    sku?: string | null;
    ctaHref: string;
    ctaLabel: string;
  }> = [];

  if (items.length === 0) return alerts;

  alerts.push({
    id: "alert-tariff-portfolio",
    severity: portfolioRisk >= 70 ? "critical" : "warn",
    kind: "tariff_mismatch",
    title: "Tarife risk skoru",
    detail: `${items.length} ürün tarifeden sapıyor · risk ${portfolioRisk}/100`,
    marketplace: "Trendyol",
    ctaHref: "/tariffs",
    ctaLabel: "Tarife sapmalarını aç",
  });

  for (const m of items.slice(0, 6)) {
    const abs = Math.abs(m.deltaPct);
    alerts.push({
      id: `alert-tariff-${m.productId}`,
      severity: abs >= 2.5 ? "critical" : "warn",
      kind: "tariff_mismatch",
      title: m.title.slice(0, 48),
      detail: `Komisyon %${m.currentRatePct} → tarife %${m.suggestedRatePct} (Δ${round2(m.deltaPct)} puan)`,
      marketplace: "Trendyol",
      sku: m.sku,
      ctaHref: m.sku
        ? `/pricing?sku=${encodeURIComponent(m.sku)}&tariff=1`
        : "/pricing?tariff=1",
      ctaLabel: "Fiyat motorunda düzelt",
    });
  }

  return alerts;
}

function buildCompetitorAlerts(
  products: ReturnType<typeof buildTrackedProducts>,
) {
  const alerts: Array<{
    id: string;
    severity: AlertSeverity;
    kind: "price_down" | "stock_down" | "stock_out" | "tariff_mismatch";
    title: string;
    detail: string;
    marketplace: string;
    sku?: string | null;
    ctaHref: string;
    ctaLabel: string;
  }> = [];

  for (const p of products) {
    if (!p.alert) continue;
    if (String(p.alert).includes("Tarife")) {
      continue;
    } else if (String(p.alert).includes("Fiyat")) {
      const critical = (p.priceDropPct ?? 0) >= 6;
      alerts.push({
        id: `alert-prod-${p.id}`,
        severity: critical ? "critical" : "warn",
        kind: "price_down",
        title: p.title,
        detail: `${p.alert} · ${p.prevPrice} → ${p.price} ₺`,
        marketplace: p.marketplace,
        sku: p.sku,
        ctaHref: p.sku
          ? `/pricing?sku=${encodeURIComponent(p.sku)}&buybox=${p.price}&tariff=1`
          : "/pricing",
        ctaLabel: "Fiyat öner",
      });
    } else if (String(p.alert).includes("tükendi")) {
      alerts.push({
        id: `alert-prod-${p.id}`,
        severity: "warn",
        kind: "stock_out",
        title: p.title,
        detail: "Stok tükendi",
        marketplace: p.marketplace,
        sku: p.sku,
        ctaHref: "/products",
        ctaLabel: "Katalogu kontrol et",
      });
    } else if (String(p.alert).includes("Stok")) {
      alerts.push({
        id: `alert-prod-${p.id}`,
        severity: "info",
        kind: "stock_down",
        title: p.title,
        detail: String(p.alert),
        marketplace: p.marketplace,
        sku: p.sku,
        ctaHref: "/products",
        ctaLabel: "Stokları gör",
      });
    }
  }

  const rank: Record<AlertSeverity, number> = {
    critical: 0,
    warn: 1,
    info: 2,
  };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 24);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
