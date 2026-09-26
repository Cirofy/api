import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { calculateNetProfit } from "../profit/profit.engine";
import { TariffsService } from "../tariffs/tariffs.service";

export type ScenarioOpts = {
  commissionDeltaPts?: number;
  shippingDelta?: number;
  flashDiscountPct?: number;
};

@Injectable()
export class ScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  async simulate(organizationId: string, dto: { productId: string } & ScenarioOpts) {
    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, organizationId },
      select: {
        id: true,
        title: true,
        sku: true,
        salePrice: true,
        costPrice: true,
        commissionRate: true,
        shippingCost: true,
        store: { select: { marketplace: true } },
      },
    });
    if (!product) throw new NotFoundException("Ürün bulunamadı");

    const baseInput = {
      salePrice: Number(product.salePrice),
      costPrice: Number(product.costPrice),
      commissionRate: Number(product.commissionRate),
      shippingCost: Number(product.shippingCost),
    };
    const result = runScenario(baseInput, dto);

    return {
      product: {
        id: product.id,
        title: product.title,
        sku: product.sku,
        marketplace:
          product.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
      },
      ...result,
    };
  }

  async catalogImpact(organizationId: string, opts: ScenarioOpts) {
    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      take: 100,
      select: {
        id: true,
        title: true,
        salePrice: true,
        costPrice: true,
        commissionRate: true,
        shippingCost: true,
        store: { select: { marketplace: true } },
      },
    });

    const items = products.map((p) => {
      const s = runScenario(
        {
          salePrice: Number(p.salePrice),
          costPrice: Number(p.costPrice),
          commissionRate: Number(p.commissionRate),
          shippingCost: Number(p.shippingCost),
        },
        opts,
      );
      return {
        id: p.id,
        title: p.title,
        marketplace:
          p.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        ...s,
      };
    });

    return {
      items,
      totalDelta: round2(items.reduce((s, r) => s + r.deltaNet, 0)),
    };
  }

  async listSaved(organizationId: string) {
    const rows = await this.prisma.savedScenario.findMany({
      where: { organizationId },
      orderBy: { updatedAt: "desc" },
      take: 30,
    });
    return rows.map(mapSaved);
  }

  async save(
    organizationId: string,
    input: {
      name: string;
      productId?: string;
      commissionDeltaPts: number;
      shippingDelta: number;
      flashDiscountPct: number;
    },
  ) {
    const name = input.name.trim().slice(0, 80) || "Senaryo";
    let productTitle: string | null = null;
    let snapshot: object | null = null;

    if (input.productId) {
      try {
        const sim = await this.simulate(organizationId, {
          productId: input.productId,
          commissionDeltaPts: input.commissionDeltaPts,
          shippingDelta: input.shippingDelta,
          flashDiscountPct: input.flashDiscountPct,
        });
        productTitle = sim.product.title;
        snapshot = {
          deltaNet: sim.deltaNet,
          deltaMarginPts: sim.deltaMarginPts,
          baseNet: sim.base.net,
          nextNet: sim.next.net,
          salePrice: sim.salePrice,
        };
      } catch {
        // ürün silinmiş olabilir
      }
    } else {
      const catalog = await this.catalogImpact(organizationId, input);
      snapshot = { totalDelta: catalog.totalDelta, itemCount: catalog.items.length };
    }

    const row = await this.prisma.savedScenario.create({
      data: {
        organizationId,
        name,
        productId: input.productId || null,
        productTitle,
        commissionDeltaPts: input.commissionDeltaPts,
        shippingDelta: input.shippingDelta,
        flashDiscountPct: input.flashDiscountPct,
        snapshot: snapshot ?? undefined,
      },
    });
    return mapSaved(row);
  }

  async remove(organizationId: string, id: string) {
    const existing = await this.prisma.savedScenario.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Senaryo bulunamadı");
    await this.prisma.savedScenario.delete({ where: { id } });
    return { ok: true };
  }

  async compare(organizationId: string, leftId: string, rightId: string) {
    const [left, right] = await Promise.all([
      this.prisma.savedScenario.findFirst({
        where: { id: leftId, organizationId },
      }),
      this.prisma.savedScenario.findFirst({
        where: { id: rightId, organizationId },
      }),
    ]);
    if (!left || !right) throw new NotFoundException("Karşılaştırılacak senaryo yok");

    const resolve = async (row: typeof left) => {
      const opts = {
        commissionDeltaPts: Number(row.commissionDeltaPts),
        shippingDelta: Number(row.shippingDelta),
        flashDiscountPct: Number(row.flashDiscountPct),
      };
      const plusSync = await this.resolvePlusSync(
        organizationId,
        row.productId,
        opts.commissionDeltaPts,
      );
      if (row.productId) {
        try {
          const sim = await this.simulate(organizationId, {
            productId: row.productId,
            ...opts,
          });
          return {
            saved: mapSaved(row),
            scope: "product" as const,
            product: sim.product,
            deltaNet: sim.deltaNet,
            deltaMarginPts: sim.deltaMarginPts,
            baseNet: sim.base.net,
            nextNet: sim.next.net,
            plus: plusSync,
          };
        } catch {
          /* fallthrough */
        }
      }
      const catalog = await this.catalogImpact(organizationId, opts);
      return {
        saved: mapSaved(row),
        scope: "catalog" as const,
        product: null,
        deltaNet: catalog.totalDelta,
        deltaMarginPts: 0,
        baseNet: 0,
        nextNet: catalog.totalDelta,
        plus: plusSync,
      };
    };

    const [a, b] = await Promise.all([resolve(left), resolve(right)]);
    const deltaNetDiff = round2(a.deltaNet - b.deltaNet);
    const winner =
      Math.abs(deltaNetDiff) < 0.005
        ? ("tie" as const)
        : deltaNetDiff > 0
          ? ("left" as const)
          : ("right" as const);
    const payload = {
      left: a,
      right: b,
      deltaNetDiff,
      winner,
      message:
        winner === "tie"
          ? "Senaryolar net değişimde eşdeğer."
          : winner === "left"
            ? `“${a.saved.name}” daha iyi net değişim.`
            : `“${b.saved.name}” daha iyi net değişim.`,
    };

    const row = await this.prisma.scenarioComparison.create({
      data: {
        organizationId,
        leftId: left.id,
        rightId: right.id,
        leftName: a.saved.name,
        rightName: b.saved.name,
        deltaNetDiff,
        winner,
        message: payload.message,
        result: payload as object,
      },
    });

    return { ...payload, id: row.id, createdAt: row.createdAt.toISOString() };
  }

  /** Ürün tarifesinden Plus puan farkı — senaryo kaydırıcısı ile senkron. */
  private async resolvePlusSync(
    organizationId: string,
    productId: string | null,
    commissionDeltaPts: number,
  ) {
    const empty = {
      plusRatePct: null as number | null,
      currentRatePct: null as number | null,
      plusDeltaPts: null as number | null,
      plusDeltaNet: null as number | null,
      synced: false,
    };
    if (!productId) return empty;
    try {
      const resolved = await this.tariffs.resolveByProductId(
        organizationId,
        productId,
      );
      if (!resolved.tariff || !resolved.product) return empty;
      const currentRatePct = resolved.product.currentRatePct;
      const plusRatePct = resolved.tariff.plusRatePct;
      const plusDeltaPts = round2(plusRatePct - currentRatePct);
      const simPlus = await this.simulate(organizationId, {
        productId,
        commissionDeltaPts: plusDeltaPts,
        shippingDelta: 0,
        flashDiscountPct: 0,
      });
      return {
        plusRatePct,
        currentRatePct,
        plusDeltaPts,
        plusDeltaNet: simPlus.deltaNet,
        synced: Math.abs(commissionDeltaPts - plusDeltaPts) < 0.05,
      };
    } catch {
      return empty;
    }
  }

  async listComparisons(organizationId: string, take = 20) {
    const rows = await this.prisma.scenarioComparison.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      leftId: r.leftId,
      rightId: r.rightId,
      leftName: r.leftName,
      rightName: r.rightName,
      deltaNetDiff: Number(r.deltaNetDiff),
      winner: r.winner as "left" | "right" | "tie",
      message: r.message,
      result: r.result,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async removeComparison(organizationId: string, id: string) {
    const existing = await this.prisma.scenarioComparison.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Karşılaştırma bulunamadı");
    await this.prisma.scenarioComparison.delete({ where: { id } });
    return { ok: true };
  }
}

function mapSaved(row: {
  id: string;
  name: string;
  productId: string | null;
  productTitle: string | null;
  commissionDeltaPts: unknown;
  shippingDelta: unknown;
  flashDiscountPct: unknown;
  snapshot: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    productId: row.productId,
    productTitle: row.productTitle,
    commissionDeltaPts: Number(row.commissionDeltaPts),
    shippingDelta: Number(row.shippingDelta),
    flashDiscountPct: Number(row.flashDiscountPct),
    snapshot: row.snapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runScenario(
  p: {
    salePrice: number;
    costPrice: number;
    commissionRate: number;
    shippingCost: number;
  },
  opts: ScenarioOpts,
) {
  const flash = Math.max(0, Math.min(80, opts.flashDiscountPct ?? 0));
  const salePrice = round2(p.salePrice * (1 - flash / 100));
  const commissionRate = Math.max(
    0,
    p.commissionRate + (opts.commissionDeltaPts ?? 0) / 100,
  );
  const shippingCost = Math.max(0, p.shippingCost + (opts.shippingDelta ?? 0));
  const base = estimate(p.salePrice, p.costPrice, p.commissionRate, p.shippingCost);
  const next = estimate(salePrice, p.costPrice, commissionRate, shippingCost);
  return {
    base,
    next,
    salePrice,
    commissionRate,
    shippingCost,
    deltaNet: round2(next.net - base.net),
    deltaMarginPts: round2(next.marginPct - base.marginPct),
  };
}

function estimate(sale: number, cost: number, rate: number, ship: number) {
  const profit = calculateNetProfit({
    grossAmount: sale,
    commission: sale * rate,
    shippingFee: ship,
    serviceFee: Math.max(4, sale * 0.015),
    vatNet: sale * 0.02,
    withholding: sale * 0.01,
    costTotal: cost,
  });
  return { net: profit.netProfit, marginPct: profit.marginPct };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
