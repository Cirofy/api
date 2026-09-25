import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TariffsService } from "../tariffs/tariffs.service";
import { calculateNetProfit } from "../profit/profit.engine";
import type { CaptureBuyboxDto } from "./dto";

export type BuyboxCaptureDto = {
  sku: string;
  marketplace: string;
  buyboxPrice: number;
  ourPrice?: number;
  merchantName?: string;
  winner?: "us" | "competitor";
  capturedAt: string;
};

@Injectable()
export class BuyboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tariffs: TariffsService,
  ) {}

  async list(organizationId: string) {
    const [products, captures, mismatches] = await Promise.all([
      this.prisma.product.findMany({
        where: { organizationId, isActive: true },
        orderBy: { updatedAt: "desc" },
        take: 80,
        select: {
          id: true,
          sku: true,
          title: true,
          salePrice: true,
          costPrice: true,
          commissionRate: true,
          shippingCost: true,
          store: { select: { marketplace: true } },
        },
      }),
      this.prisma.buyboxCapture.findMany({
        where: { organizationId },
        orderBy: { capturedAt: "desc" },
        take: 80,
      }),
      this.tariffs.listMismatches(organizationId, 100).catch(() => ({
        items: [] as Array<{
          productId: string;
          sku: string | null;
          suggestedRatePct: number;
          suggestedPlusRatePct: number;
          currentRatePct: number;
          deltaPct: number;
          tariffCategory: string;
        }>,
      })),
    ]);

    const captureBySku = new Map(
      captures.map((c) => [
        c.sku,
        {
          buyboxPrice: Number(c.buyboxPrice),
          ourPrice: c.ourPrice != null ? Number(c.ourPrice) : undefined,
          capturedAt: c.capturedAt.toISOString(),
        },
      ]),
    );
    const mismatchByProductId = new Map(
      (mismatches.items ?? []).map((m) => [m.productId, m] as const),
    );

    if (captures.length === 0) {
      return {
        items: [],
        captures: [] as BuyboxCaptureDto[],
        source: "empty" as const,
        note:
          products.length > 0
            ? "Buybox için eklenti yakalaması gerekli — tahmini rakip fiyatı gösterilmez."
            : "Ürün yok — senkron sonrası buybox oluşur.",
      };
    }

    const productBySku = new Map(
      products.filter((p) => p.sku).map((p) => [p.sku as string, p] as const),
    );

    const items = captures
      .map((cap) => {
        const p = productBySku.get(cap.sku);
        if (!p) return null;
      const ourPrice = Number(p.salePrice);
      const sku = p.sku ?? "";
      const cost = Number(p.costPrice);
      const rate = Number(p.commissionRate);
      const ship = Number(p.shippingCost);
      const captured = captureBySku.get(sku);
      if (!captured) return null;
      const buyboxPrice = captured.buyboxPrice;
      const effectiveOur = captured.ourPrice ?? ourPrice;
      const winner =
        effectiveOur <= buyboxPrice + 0.01 ? ("Biz" as const) : ("Rakip" as const);
      const competitorCount = 0;
      const ourRank = winner === "Biz" ? 1 : 2;
      const net = netAtPrice(buyboxPrice, cost, rate, ship);
      const mm = mismatchByProductId.get(p.id);
      const netAtTariff = mm
        ? netAtPrice(buyboxPrice, cost, mm.suggestedRatePct / 100, ship)
        : null;
      const netAtPlus = mm
        ? netAtPrice(buyboxPrice, cost, mm.suggestedPlusRatePct / 100, ship)
        : null;
      const tariffNetDelta =
        netAtTariff != null ? round2(netAtTariff - net) : null;

      return {
        id: p.id,
        sku,
        title: p.title,
        marketplace:
          p.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        ourPrice: round2(effectiveOur),
        buyboxPrice,
        winner,
        competitorCount,
        ourRank,
        estimatedNetAtBuybox: net,
        estimatedNetAtTariff: netAtTariff,
        estimatedNetAtPlus: netAtPlus,
        tariffNetDelta,
        costPrice: round2(cost),
        commissionRate: rate,
        shippingCost: round2(ship),
        live: true,
        capturedAt: captured.capturedAt ?? null,
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
    })
      .filter((row): row is NonNullable<typeof row> => row != null);

    return {
      items,
      captures: captures.map(mapCapture),
      source: "captured" as const,
      note: "Eklenti yakalamaları katalog ile birleştirildi.",
    };
  }

  async listCaptures(organizationId: string) {
    const rows = await this.prisma.buyboxCapture.findMany({
      where: { organizationId },
      orderBy: { capturedAt: "desc" },
      take: 40,
    });
    return {
      items: rows.map(mapCapture),
      source: rows.length ? ("persisted" as const) : ("empty" as const),
    };
  }

  async capture(organizationId: string, dto: CaptureBuyboxDto) {
    const sku = dto.sku.trim();
    const marketplace = dto.marketplace.trim();
    const capturedAt = dto.capturedAt ? new Date(dto.capturedAt) : new Date();
    const safeAt = Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt;

    const ourPrice = dto.ourPrice != null ? round2(dto.ourPrice) : null;
    const winner =
      dto.winner ??
      (ourPrice != null && ourPrice <= round2(dto.buyboxPrice) + 0.01
        ? ("us" as const)
        : ourPrice != null
          ? ("competitor" as const)
          : null);

    const row = await this.prisma.buyboxCapture.upsert({
      where: {
        organizationId_sku: { organizationId, sku },
      },
      create: {
        organizationId,
        sku,
        marketplace,
        buyboxPrice: round2(dto.buyboxPrice),
        ourPrice,
        merchantName: dto.merchantName?.trim() || null,
        winner,
        capturedAt: safeAt,
      },
      update: {
        marketplace,
        buyboxPrice: round2(dto.buyboxPrice),
        ourPrice,
        merchantName: dto.merchantName?.trim() || null,
        winner,
        capturedAt: safeAt,
      },
    });

    void this.notifications.scanOrganization(organizationId).catch(() => undefined);

    let tariffMatch: Awaited<ReturnType<TariffsService["resolveBySku"]>> | null =
      null;
    try {
      tariffMatch = await this.tariffs.resolveBySku(
        organizationId,
        sku,
        marketplace,
      );
    } catch {
      tariffMatch = null;
    }

    return {
      item: mapCapture(row),
      tariffMatch,
      message: tariffMatch?.mismatch
        ? `Buybox kaydedildi — ${tariffMatch.message}`
        : "Buybox yakalaması kaydedildi.",
    };
  }
}

function mapCapture(row: {
  sku: string;
  marketplace: string;
  buyboxPrice: unknown;
  ourPrice: unknown;
  merchantName?: string | null;
  winner?: string | null;
  capturedAt: Date;
}): BuyboxCaptureDto {
  return {
    sku: row.sku,
    marketplace: row.marketplace,
    buyboxPrice: Number(row.buyboxPrice),
    ourPrice: row.ourPrice != null ? Number(row.ourPrice) : undefined,
    merchantName: row.merchantName ?? undefined,
    winner:
      row.winner === "us" || row.winner === "competitor" ? row.winner : undefined,
    capturedAt: row.capturedAt.toISOString(),
  };
}

function netAtPrice(sale: number, cost: number, rate: number, ship: number) {
  const profit = calculateNetProfit({
    grossAmount: sale,
    commission: sale * rate,
    shippingFee: ship,
    serviceFee: Math.max(4, sale * 0.015),
    vatNet: sale * 0.02,
    withholding: sale * 0.01,
    costTotal: cost,
  });
  return profit.netProfit;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
