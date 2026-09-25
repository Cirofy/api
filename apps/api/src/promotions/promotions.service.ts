import { BadRequestException, Injectable } from "@nestjs/common";
import { decryptCredential } from "../marketplace/credential-crypto";
import { MarketplaceRegistry } from "../marketplace/marketplace.registry";
import type { MarketplaceCode } from "../marketplace/marketplace.types";
import { PrismaService } from "../prisma/prisma.service";
import { calculateNetProfit } from "../profit/profit.engine";
import type { ImportPromoOffersDto } from "./dto";

export type PromoKind =
  | "flash"
  | "advantage_label"
  | "commission_tariff"
  | "plus_commission"
  | "discount";

@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplaces: MarketplaceRegistry,
  ) {}

  async sync(organizationId: string, targetMarginPct = 15) {
    const stores = await this.prisma.store.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        marketplace: true,
        externalStoreId: true,
        apiKeyEncrypted: true,
        apiSecretEncrypted: true,
      },
    });

    if (stores.length === 0) {
      throw new BadRequestException(
        "Önce Ayarlar’dan mağaza bağlayın; kampanya senkronu anahtar ister.",
      );
    }

    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      select: {
        sku: true,
        barcode: true,
        title: true,
        salePrice: true,
        costPrice: true,
        commissionRate: true,
        shippingCost: true,
        storeId: true,
      },
    });
    const byBarcode = new Map<string, (typeof products)[number]>();
    const bySku = new Map<string, (typeof products)[number]>();
    for (const p of products) {
      if (p.barcode) byBarcode.set(p.barcode.trim(), p);
      if (p.sku) bySku.set(p.sku.trim(), p);
    }

    let upserted = 0;
    const errors: string[] = [];
    const sinceDays = 14;

    for (const store of stores) {
      if (
        store.marketplace !== "TRENDYOL" &&
        store.marketplace !== "HEPSIBURADA"
      ) {
        continue;
      }
      const apiKey = decryptCredential(store.apiKeyEncrypted);
      const apiSecret = decryptCredential(store.apiSecretEncrypted);
      if (!apiKey || !apiSecret || !store.externalStoreId?.trim()) {
        errors.push(`${store.name}: anahtar veya satıcı ID eksik`);
        continue;
      }

      const creds = {
        apiKey,
        apiSecret,
        externalStoreId: store.externalStoreId,
      };
      const adapter = this.marketplaces.get(
        store.marketplace as MarketplaceCode,
      );

      try {
        if (store.marketplace === "HEPSIBURADA" && adapter.pullSellerPromotions) {
          const promos = await adapter.pullSellerPromotions(creds);
          for (const promo of promos) {
            const sku =
              promo.sku?.trim() ||
              promo.title?.trim()?.slice(0, 40) ||
              null;
            if (!sku) continue;
            const product = bySku.get(sku) ?? byBarcode.get(sku);
            const listPrice =
              promo.listPrice ??
              (product ? Number(product.salePrice) : promo.offerPrice ?? 0);
            const offerPrice =
              promo.offerPrice ??
              (product ? Number(product.salePrice) : listPrice);
            const est = estimate(
              offerPrice,
              product ? Number(product.costPrice) : offerPrice * 0.4,
              product ? Number(product.commissionRate) : 0.12,
              product ? Number(product.shippingCost) : 35,
            );
            await this.prisma.promoOffer.upsert({
              where: {
                organizationId_sku_kind: {
                  organizationId,
                  sku,
                  kind: promo.kind,
                },
              },
              create: {
                organizationId,
                sku,
                title: promo.title?.trim() || product?.title || sku,
                kind: promo.kind,
                listPrice: round2(listPrice),
                offerPrice: round2(offerPrice),
                targetMarginPct: targetMarginPct,
                estimatedMarginPct: est.marginPct,
                estimatedNet: est.net,
                source: "live",
              },
              update: {
                title: promo.title?.trim() || product?.title || sku,
                listPrice: round2(listPrice),
                offerPrice: round2(offerPrice),
                targetMarginPct: targetMarginPct,
                estimatedMarginPct: est.marginPct,
                estimatedNet: est.net,
                source: "live",
              },
            });
            upserted += 1;
          }
        }

        if (store.marketplace === "TRENDYOL" && adapter.pullSettlements) {
          const types = ["Discount", "TyDiscount", "Coupon"];
          for (const transactionType of types) {
            const rows = await adapter.pullSettlements(creds, {
              transactionType,
              sinceDays,
            });
            for (const row of rows) {
              const barcode = row.barcode?.trim();
              if (!barcode) continue;
              const product = byBarcode.get(barcode);
              const sku = product?.sku?.trim() || barcode;
              const offerPrice = Math.abs(
                row.credit ?? row.debt ?? row.sellerRevenue ?? 0,
              );
              if (offerPrice <= 0) continue;
              const listPrice = product
                ? Number(product.salePrice)
                : offerPrice;
              const kind: PromoKind =
                transactionType === "TyDiscount" ? "flash" : "discount";
              const est = estimate(
                offerPrice,
                product ? Number(product.costPrice) : offerPrice * 0.4,
                product ? Number(product.commissionRate) : 0.12,
                product ? Number(product.shippingCost) : 35,
              );
              await this.prisma.promoOffer.upsert({
                where: {
                  organizationId_sku_kind: {
                    organizationId,
                    sku,
                    kind,
                  },
                },
                create: {
                  organizationId,
                  sku,
                  title: product?.title ?? sku,
                  kind,
                  listPrice: round2(listPrice),
                  offerPrice: round2(offerPrice),
                  targetMarginPct: targetMarginPct,
                  estimatedMarginPct: est.marginPct,
                  estimatedNet: est.net,
                  source: "live",
                },
                update: {
                  title: product?.title ?? sku,
                  listPrice: round2(listPrice),
                  offerPrice: round2(offerPrice),
                  targetMarginPct: targetMarginPct,
                  estimatedMarginPct: est.marginPct,
                  estimatedNet: est.net,
                  source: "live",
                },
              });
              upserted += 1;
            }
          }
        }
      } catch {
        errors.push(`${store.name}: kampanya çekimi tamamlanamadı`);
      }
    }

    return {
      ok: upserted > 0,
      upserted,
      message:
        upserted > 0
          ? `${upserted} kampanya teklifi kaydedildi.${
              errors.length ? ` ${errors.join(" · ")}` : ""
            }`
          : errors.length > 0
            ? errors.join(" · ")
            : "Pazaryerinden kampanya satırı alınamadı.",
    };
  }

  async overview(organizationId: string, targetMarginPct = 15) {
    const productCount = await this.prisma.product.count({
      where: { organizationId, isActive: true },
    });

    const imported = await this.prisma.promoOffer.findMany({
      where: {
        organizationId,
        source: { in: ["import", "live"] },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    if (productCount === 0 && imported.length === 0) {
      return {
        offers: [],
        realized: [],
        source: "empty" as const,
        note: "Ürün yok — senkron sonrası teklifler oluşur.",
      };
    }

    if (imported.length === 0) {
      return {
        offers: [],
        realized: [],
        source: "empty" as const,
        note: "Kampanya senkronu çalıştırın",
      };
    }

    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { id: true, sku: true },
    });
    const productIdBySku = new Map(
      products.filter((p) => p.sku).map((p) => [p.sku as string, p.id]),
    );

    const since = new Date(Date.now() - 30 * 86400_000);
    const productIds = products.map((p) => p.id);
    const orderItems =
      productIds.length === 0
        ? []
        : await this.prisma.orderItem.findMany({
            where: {
              productId: { in: productIds },
              order: { organizationId, orderedAt: { gte: since } },
            },
            select: {
              productId: true,
              quantity: true,
              unitPrice: true,
              netProfit: true,
              order: { select: { id: true } },
            },
          });

    const byProduct = new Map<
      string,
      { orders: Set<string>; qty: number; net: number; gross: number }
    >();
    for (const item of orderItems) {
      if (!item.productId) continue;
      const cur = byProduct.get(item.productId) ?? {
        orders: new Set<string>(),
        qty: 0,
        net: 0,
        gross: 0,
      };
      cur.orders.add(item.order.id);
      cur.qty += item.quantity;
      cur.net += Number(item.netProfit);
      cur.gross += Number(item.unitPrice) * item.quantity;
      byProduct.set(item.productId, cur);
    }

    const offers = imported.map((row) => ({
      id: row.id,
      kind: row.kind as PromoKind,
      sku: row.sku,
      title: row.title ?? row.sku,
      listPrice: Number(row.listPrice),
      offerPrice: Number(row.offerPrice),
      targetMarginPct: Number(row.targetMarginPct) || targetMarginPct,
      estimatedMarginPct: Number(row.estimatedMarginPct),
      estimatedNet: Number(row.estimatedNet),
      source: row.source === "live" ? ("live" as const) : ("import" as const),
      tariffLabel: null as string | null,
      tariffRatePct: null as number | null,
    }));

    const realized = offers.map((o) => {
      const productId = productIdBySku.get(o.sku);
      const stats = productId ? byProduct.get(productId) : undefined;
      const orders = stats?.orders.size ?? 0;
      const realizedNetTotal = stats ? round2(stats.net) : 0;
      const realizedMarginPct =
        stats && stats.gross > 0
          ? round2((stats.net / stats.gross) * 100)
          : o.estimatedMarginPct;
      const hasOrders = orders > 0;

      return {
        id: `cr-${o.id}`,
        offerId: o.id,
        kind: o.kind,
        sku: o.sku,
        title: o.title,
        offerPrice: o.offerPrice,
        orders,
        estimatedMarginPct: o.estimatedMarginPct,
        realizedMarginPct: hasOrders ? realizedMarginPct : o.estimatedMarginPct,
        estimatedNet: o.estimatedNet,
        realizedNetTotal: hasOrders ? realizedNetTotal : 0,
        fromOrders: hasOrders,
      };
    });

    const liveCount = offers.filter((o) => o.source === "live").length;
    const importCount = offers.filter((o) => o.source === "import").length;
    const fromOrdersCount = realized.filter((r) => r.fromOrders).length;

    return {
      offers,
      realized,
      source:
        liveCount > 0 && importCount > 0
          ? ("mixed" as const)
          : liveCount > 0
            ? ("live" as const)
            : importCount > 0
              ? ("import" as const)
              : ("empty" as const),
      note:
        liveCount > 0 || importCount > 0
          ? `${liveCount} canlı · ${importCount} içe aktarım · ${fromOrdersCount} siparişten gerçekleşen.`
          : "Kampanya senkronu çalıştırın",
    };
  }

  /** Raporlar / dışa aktarım için gerçekleşen kâr özeti. */
  async realized(organizationId: string, targetMarginPct = 15) {
    const overview = await this.overview(organizationId, targetMarginPct);
    const rows = overview.realized ?? [];
    const net = round2(
      rows.reduce((s, r) => s + Number(r.realizedNetTotal || 0), 0),
    );
    const orders = rows.reduce((s, r) => s + Number(r.orders || 0), 0);
    const worseThanEstimate = rows.filter(
      (r) =>
        r.fromOrders &&
        Number(r.realizedMarginPct) < Number(r.estimatedMarginPct) - 0.5,
    ).length;
    const fromOrders = rows.filter((r) => r.fromOrders).length;

    return {
      periodDays: 30,
      source: overview.source,
      note: overview.note,
      summary: {
        campaigns: rows.length,
        orders,
        net,
        worseThanEstimate,
        fromOrders,
      },
      rows,
      message:
        rows.length > 0
          ? `${rows.length} kampanya · net ${net.toLocaleString("tr-TR")} ₺ · ${fromOrders} siparişten.`
          : "Gerçekleşen kampanya özeti yok.",
    };
  }

  async importOffers(organizationId: string, dto: ImportPromoOffersDto) {
    const targetMargin = Math.max(0, dto.targetMargin ?? 15);
    const rows = dto.rows ?? [];
    if (rows.length === 0) {
      return { upserted: 0, missed: [] as string[], offers: [], message: "Satır yok." };
    }

    const skus = [...new Set(rows.map((r) => r.sku.trim()).filter(Boolean))];
    const products = await this.prisma.product.findMany({
      where: { organizationId, sku: { in: skus } },
      select: {
        sku: true,
        title: true,
        salePrice: true,
        costPrice: true,
        commissionRate: true,
        shippingCost: true,
      },
    });
    const bySku = new Map(products.map((p) => [p.sku ?? "", p]));

    let upserted = 0;
    const missed: string[] = [];
    const offers = [];

    for (const row of rows) {
      const sku = row.sku.trim();
      if (!sku || row.offerPrice == null) continue;
      const kind = normalizeKind(row.kind);
      const product = bySku.get(sku);
      if (!product) {
        missed.push(sku);
      }
      const listPrice =
        row.listPrice ??
        (product ? Number(product.salePrice) : row.offerPrice);
      const costPrice = product ? Number(product.costPrice) : row.offerPrice * 0.4;
      const commissionRate = product ? Number(product.commissionRate) : 0.12;
      const shippingCost = product ? Number(product.shippingCost) : 35;
      const rateBump =
        kind === "plus_commission" ? 0.02 : kind === "commission_tariff" ? 0.01 : 0;
      const est = estimate(
        row.offerPrice,
        costPrice,
        commissionRate + rateBump,
        shippingCost,
      );

      const saved = await this.prisma.promoOffer.upsert({
        where: {
          organizationId_sku_kind: { organizationId, sku, kind },
        },
        create: {
          organizationId,
          sku,
          title: row.title?.trim() || product?.title || sku,
          kind,
          listPrice: round2(listPrice),
          offerPrice: round2(row.offerPrice),
          targetMarginPct: targetMargin,
          estimatedMarginPct: est.marginPct,
          estimatedNet: est.net,
          source: "import",
        },
        update: {
          title: row.title?.trim() || product?.title || sku,
          listPrice: round2(listPrice),
          offerPrice: round2(row.offerPrice),
          targetMarginPct: targetMargin,
          estimatedMarginPct: est.marginPct,
          estimatedNet: est.net,
          source: "import",
        },
      });
      upserted += 1;
      offers.push({
        id: saved.id,
        kind: saved.kind as PromoKind,
        sku: saved.sku,
        title: saved.title ?? saved.sku,
        listPrice: Number(saved.listPrice),
        offerPrice: Number(saved.offerPrice),
        targetMarginPct: Number(saved.targetMarginPct),
        estimatedMarginPct: Number(saved.estimatedMarginPct),
        estimatedNet: Number(saved.estimatedNet),
        source: "import" as const,
      });
    }

    return {
      upserted,
      missed: missed.slice(0, 20),
      offers,
      message:
        upserted > 0
          ? `${upserted} teklif kaydedildi${missed.length ? ` · ${missed.length} SKU katalogda yok` : ""}.`
          : "Kaydedilecek satır yok.",
    };
  }
}

function normalizeKind(raw?: string): PromoKind {
  const k = (raw ?? "").toLowerCase().trim();
  if (k.includes("flash") || k.includes("flaş") || k.includes("flas")) return "flash";
  if (k.includes("plus")) return "plus_commission";
  if (k.includes("avantaj") || k.includes("advantage")) return "advantage_label";
  if (k.includes("indirim") || k.includes("discount")) return "discount";
  if (k.includes("commission_tariff") || k.includes("komisyon")) {
    return "commission_tariff";
  }
  return "flash";
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
