import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TariffsService } from "../tariffs/tariffs.service";

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  async analysis(organizationId: string, days = 30) {
    const since = new Date(Date.now() - days * 86400_000);
    const returned = await this.prisma.order.findMany({
      where: {
        organizationId,
        status: "RETURNED",
        orderedAt: { gte: since },
      },
      orderBy: { orderedAt: "desc" },
      take: 500,
      select: {
        id: true,
        externalId: true,
        orderedAt: true,
        grossAmount: true,
        netProfit: true,
        costTotal: true,
        commission: true,
        shippingFee: true,
        store: { select: { name: true, marketplace: true } },
        items: {
          take: 3,
          select: {
            quantity: true,
            product: {
              select: {
                sku: true,
                title: true,
                category: true,
                brand: true,
                returnRatePct: true,
              },
            },
          },
        },
      },
    });

    const allCount = await this.prisma.order.count({
      where: { organizationId, orderedAt: { gte: since } },
    });

    const bySku = new Map<
      string,
      {
        sku: string;
        title: string;
        category: string;
        brand: string;
        count: number;
        gross: number;
        netLoss: number;
        returnFeeEst: number;
        returnRatePct: number;
      }
    >();
    const byCategory = new Map<
      string,
      { category: string; count: number; netLoss: number; gross: number }
    >();
    const byMarketplace = new Map<
      string,
      { marketplace: string; count: number; netLoss: number; gross: number }
    >();

    let totalNetLoss = 0;
    let totalGross = 0;
    let totalReturnFees = 0;

    const rows = returned.map((o) => {
      const marketplace =
        o.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol";
      const product = o.items[0]?.product;
      const sku = product?.sku ?? "—";
      const title = product?.title ?? "Ürün";
      const category = product?.category ?? "Diğer";
      const brand = product?.brand ?? "—";
      const gross = Number(o.grossAmount);
      const net = Number(o.netProfit);
      const netLoss = Math.min(0, net);
      const returnFeeEst = 25 + Number(o.shippingFee) * 0.15;
      totalNetLoss += netLoss;
      totalGross += gross;
      totalReturnFees += returnFeeEst;

      const skuKey = sku;
      const skuCur = bySku.get(skuKey) ?? {
        sku,
        title,
        category,
        brand,
        count: 0,
        gross: 0,
        netLoss: 0,
        returnFeeEst: 0,
        returnRatePct: Number(product?.returnRatePct ?? 0),
      };
      skuCur.count += 1;
      skuCur.gross += gross;
      skuCur.netLoss += netLoss;
      skuCur.returnFeeEst += returnFeeEst;
      bySku.set(skuKey, skuCur);

      const catCur = byCategory.get(category) ?? {
        category,
        count: 0,
        netLoss: 0,
        gross: 0,
      };
      catCur.count += 1;
      catCur.netLoss += netLoss;
      catCur.gross += gross;
      byCategory.set(category, catCur);

      const mktCur = byMarketplace.get(marketplace) ?? {
        marketplace,
        count: 0,
        netLoss: 0,
        gross: 0,
      };
      mktCur.count += 1;
      mktCur.netLoss += netLoss;
      mktCur.gross += gross;
      byMarketplace.set(marketplace, mktCur);

      return {
        id: o.id,
        externalId: o.externalId,
        orderedAt: o.orderedAt.toISOString(),
        marketplace,
        storeName: o.store.name,
        sku,
        title,
        category,
        brand,
        grossAmount: round2(gross),
        netProfit: round2(net),
        netLoss: round2(netLoss),
        returnFeeEst: round2(returnFeeEst),
        costTotal: round2(Number(o.costTotal)),
        commission: round2(Number(o.commission)),
      };
    });

    const returnRatePct =
      allCount > 0 ? round2((returned.length / allCount) * 100) : 0;

    let mismatches: Awaited<
      ReturnType<TariffsService["listMismatches"]>
    >["items"] = [];
    try {
      const mm = await this.tariffs.listMismatches(organizationId, 200);
      mismatches = mm.items ?? [];
    } catch {
      mismatches = [];
    }
    const mismatchBySku = new Map(
      mismatches
        .filter((m) => m.sku)
        .map((m) => [m.sku as string, m]),
    );

    const bySkuRows = [...bySku.values()]
      .map((r) => {
        const mm = mismatchBySku.get(r.sku);
        const deltaPct = mm ? mm.deltaPct : 0;
        // Yaklaşık: komisyon farkı × iade brütü (zarar tarafına ek etki)
        const tariffAdjustment =
          mm && r.gross > 0
            ? round2(-((deltaPct / 100) * r.gross))
            : 0;
        return {
          ...r,
          gross: round2(r.gross),
          netLoss: round2(r.netLoss),
          returnFeeEst: round2(r.returnFeeEst),
          returnRatePct: round2(r.returnRatePct),
          tariffMismatch: mm
            ? {
                productId: mm.productId,
                currentRatePct: mm.currentRatePct,
                suggestedRatePct: mm.suggestedRatePct,
                suggestedPlusRatePct: mm.suggestedPlusRatePct,
                deltaPct: mm.deltaPct,
                tariffCategory: mm.tariffCategory,
              }
            : null,
          tariffAdjustment,
          netLossAtTariff: round2(r.netLoss + tariffAdjustment),
        };
      })
      .sort((a, b) => a.netLoss - b.netLoss)
      .slice(0, 30);

    const tariffMismatchSkuCount = bySkuRows.filter(
      (r) => r.tariffMismatch,
    ).length;

    const recent = rows.slice(0, 40).map((r) => {
      const mm = mismatchBySku.get(r.sku);
      return {
        ...r,
        tariffMismatch: mm
          ? {
              productId: mm.productId,
              currentRatePct: mm.currentRatePct,
              suggestedRatePct: mm.suggestedRatePct,
              suggestedPlusRatePct: mm.suggestedPlusRatePct,
              deltaPct: mm.deltaPct,
              tariffCategory: mm.tariffCategory,
            }
          : null,
      };
    });

    return {
      periodDays: days,
      hasData: returned.length > 0 || allCount > 0,
      summary: {
        returnCount: returned.length,
        orderCount: allCount,
        returnRatePct,
        netLoss: round2(totalNetLoss),
        grossReturned: round2(totalGross),
        returnFees: round2(totalReturnFees),
        avgLossPerReturn:
          returned.length > 0
            ? round2(totalNetLoss / returned.length)
            : 0,
        tariffMismatchSkuCount,
      },
      bySku: bySkuRows,
      byCategory: [...byCategory.values()]
        .map((r) => ({
          ...r,
          gross: round2(r.gross),
          netLoss: round2(r.netLoss),
        }))
        .sort((a, b) => a.netLoss - b.netLoss),
      byMarketplace: [...byMarketplace.values()]
        .map((r) => ({
          ...r,
          gross: round2(r.gross),
          netLoss: round2(r.netLoss),
        }))
        .sort((a, b) => a.netLoss - b.netLoss),
      recent,
    };
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
