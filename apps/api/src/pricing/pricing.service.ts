import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { calculateNetProfit } from "../profit/profit.engine";
import { TariffsService } from "../tariffs/tariffs.service";
import type { ApplyPricesDto } from "./dto";

export type PriceTargetMode = "margin_pct" | "net_amount" | "markup_pct";

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  async listSuggestions(
    organizationId: string,
    mode: PriceTargetMode = "margin_pct",
    target = 15,
    tsfMarkupPct = 8,
    usePlus = false,
  ) {
    const markup = Math.max(0, Math.min(40, tsfMarkupPct));
    const factor = 1 + markup / 100;
    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        sku: true,
        title: true,
        category: true,
        costPrice: true,
        salePrice: true,
        commissionRate: true,
        shippingCost: true,
        brand: true,
        store: { select: { id: true, marketplace: true, name: true } },
      },
    });

    const items = [];
    for (const p of products) {
      const cost = Number(p.costPrice);
      const sale = Number(p.salePrice);
      const rate = Number(p.commissionRate);
      const ship = Number(p.shippingCost);
      const current = estimateAtSale(sale, cost, rate, ship);
      const suggested = suggestForMode({ cost, rate, ship }, mode, target);
      const tsf = round2(sale * factor);
      const netAtTsf = estimateAtSale(tsf, cost, rate, ship);

      let tariffSim: {
        tariffRatePct: number;
        plusRatePct: number;
        isOverride: boolean;
        atTariff: ReturnType<typeof estimateAtSale>;
        atPlus: ReturnType<typeof estimateAtSale>;
        tariffDeltaPct: number;
        tariffDeltaNet: number;
        suggestedAtTariff: number;
        suggestedAtPlus: number;
      } | null = null;

      try {
        const marketplace =
          p.store?.marketplace === "HEPSIBURADA" ? "HEPSIBURADA" : "TRENDYOL";
        const resolved = await this.tariffs.resolveForProduct(
          organizationId,
          marketplace,
          p.category ?? "Diğer",
          p.store?.id ?? null,
        );
        if (resolved) {
          const atTariff = estimateAtSale(sale, cost, resolved.rate, ship);
          const atPlus = estimateAtSale(sale, cost, resolved.plusRate, ship);
          const activeRate = usePlus ? resolved.plusRate : resolved.rate;
          const activeEst = usePlus ? atPlus : atTariff;
          tariffSim = {
            tariffRatePct: resolved.ratePct,
            plusRatePct: resolved.plusRatePct,
            isOverride: Boolean(resolved.isOverride),
            atTariff,
            atPlus,
            tariffDeltaPct: round2((activeRate - rate) * 100),
            tariffDeltaNet: round2(activeEst.net - current.net),
            suggestedAtTariff: suggestForMode(
              { cost, rate: resolved.rate, ship },
              mode,
              target,
            ).salePrice,
            suggestedAtPlus: suggestForMode(
              { cost, rate: resolved.plusRate, ship },
              mode,
              target,
            ).salePrice,
          };
        }
      } catch {
        // tarife yoksa simülasyon atlanır
      }

      items.push({
        id: p.id,
        sku: p.sku,
        title: p.title,
        brand: p.brand,
        category: p.category,
        marketplace:
          p.store?.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        storeId: p.store?.id ?? null,
        storeName: p.store?.name ?? null,
        costPrice: cost,
        salePrice: sale,
        commissionRate: rate,
        shippingCost: ship,
        current,
        suggested,
        tsf,
        tsfMarkupPct: markup,
        customerPrice: sale,
        netAtCustomer: current,
        netAtTsf,
        marginAtTsfPct: netAtTsf.marginPct,
        usePlus,
        tariff: tariffSim,
      });
    }

    return {
      mode,
      target,
      tsfMarkupPct: markup,
      usePlus,
      count: items.length,
      items,
    };
  }

  async applyPrices(organizationId: string, dto: ApplyPricesDto) {
    if (!dto.acknowledged) {
      return {
        updated: 0,
        missed: [] as string[],
        message: "Toplu güncelleme için onay gerekli.",
      };
    }

    let updated = 0;
    const missed: string[] = [];
    const snapshot: Array<{
      productId: string;
      sku: string | null;
      title: string;
      previousPrice: number;
      salePrice: number;
    }> = [];

    for (const item of dto.items) {
      const product = await this.prisma.product.findFirst({
        where: { id: item.productId, organizationId },
        select: { id: true, sku: true, title: true, salePrice: true },
      });
      if (!product) {
        missed.push(item.productId);
        continue;
      }
      snapshot.push({
        productId: product.id,
        sku: product.sku,
        title: product.title,
        previousPrice: Number(product.salePrice),
        salePrice: item.salePrice,
      });
      await this.prisma.product.update({
        where: { id: product.id },
        data: { salePrice: item.salePrice },
      });
      updated += 1;
    }

    if (updated === 0 && dto.items.length > 0) {
      throw new NotFoundException("Güncellenecek ürün bulunamadı");
    }

    if (updated > 0) {
      await this.prisma.priceApplyLog.create({
        data: {
          organizationId,
          itemCount: updated,
          acknowledged: true,
          note: "Toplu satış fiyatı güncellemesi",
          items: snapshot,
        },
      });
    }

    return {
      updated,
      missed: missed.slice(0, 20),
      message:
        updated > 0
          ? `${updated} ürün satış fiyatı güncellendi. Bu işlem geri alınamaz.`
          : "Değişiklik uygulanamadı.",
    };
  }
}

function estimateAtSale(
  sale: number,
  cost: number,
  rate: number,
  ship: number,
) {
  const commission = sale * rate;
  const serviceFee = Math.max(4, sale * 0.015);
  const vatNet = sale * 0.02;
  const withholding = sale * 0.01;
  const profit = calculateNetProfit({
    grossAmount: sale,
    commission,
    shippingFee: ship,
    serviceFee,
    vatNet,
    withholding,
    costTotal: cost,
  });
  return {
    net: profit.netProfit,
    marginPct: profit.marginPct,
    commission: round2(commission),
    serviceFee: round2(serviceFee),
    vatNet: round2(vatNet),
    withholding: round2(withholding),
  };
}

function suggestForMode(
  p: { cost: number; rate: number; ship: number },
  mode: PriceTargetMode,
  target: number,
) {
  return binarySuggest(p, mode, target);
}

function binarySuggest(
  p: { cost: number; rate: number; ship: number },
  mode: PriceTargetMode,
  target: number,
) {
  let lo = Math.max(1, p.cost + p.ship * 0.5);
  let hi = Math.max(lo * 2, p.cost * 8 + 500);

  const hit = (sale: number) => {
    const est = estimateAtSale(sale, p.cost, p.rate, p.ship);
    if (mode === "margin_pct") return est.marginPct - target;
    if (mode === "net_amount") return est.net - target;
    const markup = p.cost > 0 ? (est.net / p.cost) * 100 : 0;
    return markup - target;
  };

  if (hit(hi) < 0) hi *= 2;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (hit(mid) < 0) lo = mid;
    else hi = mid;
  }

  const salePrice = round2(hi);
  return { salePrice, ...estimateAtSale(salePrice, p.cost, p.rate, p.ship) };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
