import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { calculateNetProfit } from "../profit/profit.engine";

export type HealthFactor = {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
};

@Injectable()
export class AgencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async portfolio(organizationId: string) {
    const stores = await this.prisma.store.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        marketplace: true,
        isConnected: true,
      },
    });

    if (stores.length === 0) {
      return {
        items: [],
        source: "empty" as const,
        note: "Mağaza yok — bağladıktan sonra portföy dolacak.",
      };
    }

    const since = new Date(Date.now() - 30 * 86400_000);
    const [openSettlementOrg, tariffs] = await Promise.all([
      this.prisma.settlementIssue.count({
        where: { organizationId, status: "open" },
      }),
      this.prisma.commissionTariff.findMany({
        where: { organizationId },
      }),
    ]);
    const byKey = new Map(
      tariffs.map((t) => [
        `${t.marketplace}::${t.category.trim().toLowerCase()}`,
        t,
      ]),
    );
    const fallbackByMarket = new Map(
      tariffs
        .filter((t) => t.category.trim().toLowerCase() === "diğer")
        .map((t) => [t.marketplace, t]),
    );
    // Hakediş org düzeyinde; çoklu mağazada skora eşit paylaştırılır.
    const openSettlementShare =
      stores.length <= 1
        ? openSettlementOrg
        : Math.ceil(openSettlementOrg / stores.length);

    const items = await Promise.all(
      stores.map(async (store) => {
        const [agg, returned, products] = await Promise.all([
          this.prisma.order.aggregate({
            where: {
              organizationId,
              storeId: store.id,
              orderedAt: { gte: since },
            },
            _sum: { netProfit: true, grossAmount: true },
            _count: true,
          }),
          this.prisma.order.count({
            where: {
              organizationId,
              storeId: store.id,
              orderedAt: { gte: since },
              status: "RETURNED",
            },
          }),
          this.prisma.product.findMany({
            where: { organizationId, storeId: store.id, isActive: true },
            select: {
              salePrice: true,
              costPrice: true,
              commissionRate: true,
              shippingCost: true,
              returnRatePct: true,
              stockQty: true,
              category: true,
            },
            take: 200,
          }),
        ]);
        const openSettlement = openSettlementShare;

        const net = Number(agg._sum.netProfit ?? 0);
        const gross = Number(agg._sum.grossAmount ?? 0);
        const orderCount = agg._count;
        const marginPct = gross > 0 ? (net / gross) * 100 : 0;
        const returnRatePct =
          orderCount > 0 ? (returned / orderCount) * 100 : 0;

        let lowMarginSku = 0;
        let lowStockSku = 0;
        let highReturnSku = 0;
        let tariffMismatchCount = 0;
        for (const p of products) {
          const sale = Number(p.salePrice);
          const cost = Number(p.costPrice);
          const rate = Number(p.commissionRate);
          const ship = Number(p.shippingCost);
          const profit = calculateNetProfit({
            grossAmount: sale,
            commission: sale * rate,
            shippingFee: ship,
            serviceFee: Math.max(4, sale * 0.015),
            vatNet: sale * 0.02,
            withholding: sale * 0.01,
            costTotal: cost,
          });
          if (sale > 0 && profit.marginPct < 8) lowMarginSku += 1;
          if (p.stockQty != null && p.stockQty <= 5) lowStockSku += 1;
          if (Number(p.returnRatePct) >= 8) highReturnSku += 1;

          const cat = p.category?.trim();
          if (cat) {
            const exact = byKey.get(
              `${store.marketplace}::${cat.toLowerCase()}`,
            );
            const tariff = exact ?? fallbackByMarket.get(store.marketplace);
            if (tariff && Math.abs(Number(tariff.rate) - rate) > 0.0005) {
              tariffMismatchCount += 1;
            }
          }
        }

        const scored = scoreStore({
          isConnected: store.isConnected,
          marginPct,
          returnRatePct,
          orderCount,
          lowMarginSku,
          lowStockSku,
          highReturnSku,
          openSettlement,
          productCount: products.length,
          tariffMismatchCount,
        });

        const openIssues =
          returned +
          openSettlement +
          (marginPct < 8 && orderCount > 0 ? 2 : 0) +
          Math.min(3, lowMarginSku) +
          Math.min(5, tariffMismatchCount);

        const actionPick = pickHealthActions(scored.factors, {
          lowMarginSku,
          lowStockSku,
          tariffMismatchCount,
        });

        return {
          id: store.id,
          storeName: store.name,
          marketplace:
            store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
          netProfit: round2(net),
          marginPct: round2(marginPct),
          orderCount,
          grossAmount: round2(gross),
          openIssues,
          health: scored.health,
          healthScore: scored.score,
          healthFactors: scored.factors,
          returnRatePct: round2(returnRatePct),
          isConnected: store.isConnected,
          productCount: products.length,
          lowMarginSku,
          lowStockSku,
          tariffMismatchCount,
          ctaHref: actionPick.primary.href,
          ctaLabel: actionPick.primary.label,
          actions: actionPick.actions,
        };
      }),
    );

    items.sort((a, b) => a.healthScore - b.healthScore);

    const avgScore =
      items.length > 0
        ? Math.round(
            items.reduce((s, i) => s + i.healthScore, 0) / items.length,
          )
        : 0;

    const tariffMismatchTotal = items.reduce(
      (s, i) => s + i.tariffMismatchCount,
      0,
    );
    const avgTariffScore =
      items.length > 0
        ? Math.round(
            items.reduce((s, i) => {
              const f = i.healthFactors.find((x) => x.key === "tariff");
              return s + (f ? (f.points / f.max) * 100 : 100);
            }, 0) / items.length,
          )
        : 100;

    return {
      items,
      avgHealthScore: avgScore,
      avgTariffScore,
      tariffMismatchTotal,
      openSettlementTotal: openSettlementOrg,
      source: "computed" as const,
      note: "Son 30 gün · sağlık skoru 0–100 (marj, iade, katalog, tarife, hakediş, bağlantı).",
    };
  }

  /** Mağaza bazlı tarife SLA — skor eşiği ve sapma limiti. */
  async tariffSla(organizationId: string) {
    const portfolio = await this.portfolio(organizationId);
    const slaScoreMin = 70;
    const slaMismatchMax = 3;
    const slaMismatchRateMax = 15;

    const tariffs = await this.prisma.commissionTariff.findMany({
      where: { organizationId },
      select: { marketplace: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    const latestByMarket = new Map<string, Date>();
    for (const t of tariffs) {
      if (!latestByMarket.has(t.marketplace)) {
        latestByMarket.set(t.marketplace, t.updatedAt);
      }
    }

    const items = (portfolio.items ?? []).map((row) => {
      const tariffFactor = row.healthFactors.find((f) => f.key === "tariff");
      const tariffScore = tariffFactor
        ? Math.round((tariffFactor.points / tariffFactor.max) * 100)
        : 100;
      const mismatchRatePct =
        row.productCount > 0
          ? round2((row.tariffMismatchCount / row.productCount) * 100)
          : 0;
      const marketCode =
        row.marketplace === "Hepsiburada" ? "HEPSIBURADA" : "TRENDYOL";
      const lastTariffAt = latestByMarket.get(marketCode)?.toISOString() ?? null;
      const daysSinceUpdate = lastTariffAt
        ? Math.floor(
            (Date.now() - Date.parse(lastTariffAt)) / 86400_000,
          )
        : null;

      let slaStatus: "ok" | "watch" | "breach" = "ok";
      if (
        tariffScore < slaScoreMin ||
        row.tariffMismatchCount > slaMismatchMax ||
        mismatchRatePct > slaMismatchRateMax
      ) {
        slaStatus = "breach";
      } else if (
        tariffScore < 85 ||
        row.tariffMismatchCount > 0 ||
        (daysSinceUpdate != null && daysSinceUpdate > 45)
      ) {
        slaStatus = "watch";
      }

      return {
        id: row.id,
        storeName: row.storeName,
        marketplace: row.marketplace,
        productCount: row.productCount,
        tariffMismatchCount: row.tariffMismatchCount,
        mismatchRatePct,
        tariffScore,
        healthScore: row.healthScore,
        lastTariffAt,
        daysSinceUpdate,
        slaStatus,
        ctaHref: "/tariffs",
        ctaLabel:
          slaStatus === "breach"
            ? "Tarife sapmalarını düzelt"
            : "Tarifeleri gözden geçir",
      };
    });

    items.sort((a, b) => {
      const rank = { breach: 0, watch: 1, ok: 2 } as const;
      const d = rank[a.slaStatus] - rank[b.slaStatus];
      if (d !== 0) return d;
      return a.tariffScore - b.tariffScore;
    });

    const breachedCount = items.filter((i) => i.slaStatus === "breach").length;
    const watchCount = items.filter((i) => i.slaStatus === "watch").length;
    const okCount = items.filter((i) => i.slaStatus === "ok").length;
    const avgTariffScore =
      typeof portfolio.avgTariffScore === "number"
        ? portfolio.avgTariffScore
        : items.length > 0
          ? Math.round(
              items.reduce((s, i) => s + i.tariffScore, 0) / items.length,
            )
          : 100;

    return {
      items,
      slaScoreMin,
      slaMismatchMax,
      slaMismatchRateMax,
      breachedCount,
      watchCount,
      okCount,
      avgTariffScore,
      tariffMismatchTotal:
        typeof portfolio.tariffMismatchTotal === "number"
          ? portfolio.tariffMismatchTotal
          : items.reduce((s, i) => s + i.tariffMismatchCount, 0),
      source: portfolio.source,
      note: `SLA: tarife skoru ≥${slaScoreMin}, sapma ≤${slaMismatchMax} ürün ve ≤%${slaMismatchRateMax}.`,
    };
  }

  /** Tarife SLA özetini e-posta ile gönder (rapor mail adresi kullanılır). */
  async enqueueTariffSlaDigest(organizationId: string) {
    const pref = await this.prisma.reportMailPref.findUnique({
      where: { organizationId },
    });
    const email = pref?.email?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) {
      return {
        ok: false,
        status: "skipped" as const,
        message:
          "Rapor e-posta adresi yok — Raporlar sayfasından mail tercihini kaydedin.",
      };
    }

    const sla = await this.tariffSla(organizationId);
    const focus = (sla.items ?? [])
      .filter((i) => i.slaStatus !== "ok")
      .slice(0, 8);
    const lines = [
      "Cirofy · Tarife SLA özeti",
      "",
      sla.note,
      `İhlal: ${sla.breachedCount} · İzle: ${sla.watchCount} · Uyumlu: ${sla.okCount}`,
      `Ortalama tarife skoru: ${sla.avgTariffScore}`,
      `Toplam sapma: ${sla.tariffMismatchTotal} ürün`,
      "",
      ...(focus.length
        ? [
            "Dikkat gereken mağazalar:",
            ...focus.map(
              (i) =>
                `· ${i.storeName} (${i.marketplace}) — skor ${i.tariffScore}, sapma ${i.tariffMismatchCount} (%${i.mismatchRatePct}) · ${i.slaStatus === "breach" ? "İhlal" : "İzle"}`,
            ),
          ]
        : ["Tüm mağazalar SLA uyumlu."]),
      "",
      "Detay için panelde Ajans → Tarife SLA bölümüne bakın.",
    ];
    const text = lines.join("\n");
    const html = `<div style="font-family:system-ui,sans-serif;color:#0B1424">
      <h2 style="margin:0 0 12px">Tarife SLA özeti</h2>
      <p style="margin:0 0 8px;color:#5b6575">${escapeHtml(sla.note)}</p>
      <p style="margin:0 0 16px"><strong>İhlal ${sla.breachedCount}</strong> · İzle ${sla.watchCount} · Uyumlu ${sla.okCount} · Skor ${sla.avgTariffScore}</p>
      ${
        focus.length
          ? `<ul style="padding-left:18px">${focus
              .map(
                (i) =>
                  `<li style="margin-bottom:6px"><strong>${escapeHtml(i.storeName)}</strong> — skor ${i.tariffScore}, sapma ${i.tariffMismatchCount}</li>`,
              )
              .join("")}</ul>`
          : `<p style="color:#0f766e">Tüm mağazalar SLA uyumlu.</p>`
      }
    </div>`;

    const job = await this.prisma.reportDigestJob.create({
      data: {
        organizationId,
        cadence: "tariff_sla",
        email,
        status: "queued",
        note: "Tarife SLA özeti",
        payload: {
          breachedCount: sla.breachedCount,
          watchCount: sla.watchCount,
          okCount: sla.okCount,
          avgTariffScore: sla.avgTariffScore,
        },
      },
    });

    const result = await this.mail.send({
      to: email,
      subject: "Cirofy · Tarife SLA özeti",
      text,
      html,
    });

    const status = result.ok ? "sent" : "failed";
    await this.prisma.reportDigestJob.update({
      where: { id: job.id },
      data: {
        status,
        note: result.ok
          ? result.mode === "smtp"
            ? "SLA özeti gönderildi"
            : "SLA özeti kuyruğa alındı"
          : result.error,
        sentAt: result.ok ? new Date() : null,
      },
    });

    return {
      ok: result.ok,
      status,
      jobId: job.id,
      email,
      breachedCount: sla.breachedCount,
      watchCount: sla.watchCount,
      message: result.ok
        ? `SLA özeti ${email} adresine iletildi.`
        : result.error || "E-posta gönderilemedi.",
    };
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreStore(input: {
  isConnected: boolean;
  marginPct: number;
  returnRatePct: number;
  orderCount: number;
  lowMarginSku: number;
  lowStockSku: number;
  highReturnSku: number;
  openSettlement: number;
  productCount: number;
  tariffMismatchCount: number;
}) {
  const factors: HealthFactor[] = [];

  // Bağlantı (15)
  const connPts = input.isConnected ? 15 : 0;
  factors.push({
    key: "connection",
    label: "Bağlantı",
    points: connPts,
    max: 15,
    detail: input.isConnected ? "Mağaza bağlı" : "Bağlantı yok",
  });

  // Marj (30)
  let marginPts = 0;
  if (input.orderCount === 0) {
    marginPts = 15;
  } else if (input.marginPct >= 15) {
    marginPts = 30;
  } else if (input.marginPct >= 12) {
    marginPts = 24;
  } else if (input.marginPct >= 8) {
    marginPts = 16;
  } else if (input.marginPct >= 0) {
    marginPts = 7;
  } else {
    marginPts = 0;
  }
  factors.push({
    key: "margin",
    label: "Marj",
    points: marginPts,
    max: 30,
    detail:
      input.orderCount === 0
        ? "Henüz sipariş yok"
        : `Net marj %${round2(input.marginPct)}`,
  });

  // İade (20)
  let returnPts = 20;
  if (input.returnRatePct >= 12 || input.highReturnSku >= 5) returnPts = 4;
  else if (input.returnRatePct >= 8 || input.highReturnSku >= 2) returnPts = 10;
  else if (input.returnRatePct >= 4) returnPts = 15;
  factors.push({
    key: "returns",
    label: "İade",
    points: returnPts,
    max: 20,
    detail: `İade oranı %${round2(input.returnRatePct)} · ${input.highReturnSku} riskli SKU`,
  });

  // Stok / düşük marj SKU (12)
  let catalogPts = 12;
  if (input.lowMarginSku >= 8 || input.lowStockSku >= 10) catalogPts = 3;
  else if (input.lowMarginSku >= 3 || input.lowStockSku >= 4) catalogPts = 7;
  else if (input.productCount === 0) catalogPts = 6;
  factors.push({
    key: "catalog",
    label: "Katalog",
    points: catalogPts,
    max: 12,
    detail: `${input.lowMarginSku} düşük marj · ${input.lowStockSku} düşük stok`,
  });

  // Tarife sapması (10)
  let tariffPts = 10;
  if (input.tariffMismatchCount >= 10) tariffPts = 2;
  else if (input.tariffMismatchCount >= 4) tariffPts = 5;
  else if (input.tariffMismatchCount >= 1) tariffPts = 7;
  factors.push({
    key: "tariff",
    label: "Tarife",
    points: tariffPts,
    max: 10,
    detail:
      input.tariffMismatchCount > 0
        ? `${input.tariffMismatchCount} ürün tarifeden sapıyor`
        : "Tarife uyumlu",
  });

  // Hakediş sapması (13)
  let settlePts = 13;
  if (input.openSettlement >= 5) settlePts = 2;
  else if (input.openSettlement >= 2) settlePts = 6;
  else if (input.openSettlement >= 1) settlePts = 9;
  factors.push({
    key: "settlement",
    label: "Hakediş",
    points: settlePts,
    max: 13,
    detail:
      input.openSettlement > 0
        ? `${input.openSettlement} açık sapma`
        : "Açık sapma yok",
  });

  const score = Math.max(
    0,
    Math.min(
      100,
      factors.reduce((s, f) => s + f.points, 0),
    ),
  );

  const health =
    score < 45 ? ("risk" as const) : score < 70 ? ("watch" as const) : ("good" as const);

  return { score, health, factors };
}

export type HealthAction = { href: string; label: string };

/** En zayıf sağlık faktörüne göre aksiyon önerileri. */
function pickHealthActions(
  factors: HealthFactor[],
  extras?: {
    lowMarginSku?: number;
    lowStockSku?: number;
    tariffMismatchCount?: number;
  },
): { primary: HealthAction; actions: HealthAction[] } {
  const byKey: Record<string, HealthAction> = {
    connection: { href: "/settings", label: "Bağlantıyı kontrol et" },
    margin: { href: "/pricing", label: "Fiyat motoruna git" },
    returns: { href: "/returns", label: "İade zararını aç" },
    catalog: { href: "/products", label: "Katalogu düzelt" },
    tariff: { href: "/tariffs", label: "Tarife sapmalarını aç" },
    settlement: { href: "/settlements", label: "Hakedişe bak" },
  };

  const ranked = [...factors]
    .map((f) => ({ ...f, deficit: f.max - f.points }))
    .filter((f) => f.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  const actions: HealthAction[] = [];
  const seen = new Set<string>();

  if ((extras?.tariffMismatchCount ?? 0) >= 3) {
    actions.push(byKey.tariff!);
    seen.add("/tariffs");
  }

  for (const f of ranked) {
    let action = byKey[f.key];
    if (f.key === "catalog" && (extras?.lowMarginSku ?? 0) >= (extras?.lowStockSku ?? 0)) {
      action = { href: "/pricing", label: "Düşük marj SKU’ları fiyatla" };
    }
    if (!action || seen.has(action.href)) continue;
    seen.add(action.href);
    actions.push(action);
  }

  if (actions.length === 0) {
    actions.push({ href: "/orders", label: "Siparişleri gör" });
  }

  return { primary: actions[0]!, actions: actions.slice(0, 3) };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
