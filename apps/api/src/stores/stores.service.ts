import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { calculateNetProfit } from "../profit/profit.engine";
import { MarketplaceRegistry } from "../marketplace/marketplace.registry";
import type { MarketplaceCode } from "../marketplace/marketplace.types";
import { MarketplacePullError } from "../marketplace/pull-error";
import { NotificationsService } from "../notifications/notifications.service";
import { ConnectStoreDto } from "./dto";
import {
  decryptCredential,
  encryptCredential,
} from "../marketplace/credential-crypto";

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplaces: MarketplaceRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  list(organizationId: string) {
    return this.prisma.store.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        marketplace: true,
        externalStoreId: true,
        isConnected: true,
        lastSyncAt: true,
        createdAt: true,
      },
    });
  }

  async connect(organizationId: string, dto: ConnectStoreDto) {
    const externalStoreId = dto.externalStoreId?.trim();
    if (!externalStoreId) {
      throw new BadRequestException(
        "Satıcı ID gerekli. Pazaryeri satıcı numarasını girin.",
      );
    }
    return this.prisma.store.create({
      data: {
        organizationId,
        marketplace: dto.marketplace,
        name: dto.name.trim(),
        externalStoreId,
        apiKeyEncrypted: encryptCredential(dto.apiKey),
        apiSecretEncrypted: encryptCredential(dto.apiSecret),
        isConnected: true,
        lastSyncAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        marketplace: true,
        externalStoreId: true,
        isConnected: true,
        lastSyncAt: true,
      },
    });
  }

  /** Adapter üzerinden ürün/sipariş çek — yalnızca canlı pazaryeri */
  async pullMarketplaceData(organizationId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, organizationId },
    });
    if (!store) throw new NotFoundException("Mağaza bulunamadı");

    let pulled;
    try {
      const adapter = this.marketplaces.get(store.marketplace as MarketplaceCode);
      pulled = await adapter.pull(
        {
          apiKey: decryptCredential(store.apiKeyEncrypted),
          apiSecret: decryptCredential(store.apiSecretEncrypted),
          externalStoreId: store.externalStoreId,
        },
        { sinceDays: 7 },
      );
    } catch (err) {
      const message =
        err instanceof MarketplacePullError
          ? err.message
          : "Pazaryeri çekimi tamamlanamadı. Tekrar deneyin.";
      throw new BadRequestException(message);
    }

    if (pulled.source !== "live") {
      throw new BadRequestException(
        "Canlı pazaryeri verisi alınamadı. Anahtarları kontrol edip tekrar deneyin.",
      );
    }

    const productMap = new Map<string, { id: string; cost: number; rate: number; ship: number }>();
    const seenExternalIds = new Set<string>();

    for (const item of pulled.products) {
      seenExternalIds.add(item.externalId);
      const listed = item.listed !== false;
      const product = await this.prisma.product.upsert({
        where: {
          storeId_externalId: { storeId, externalId: item.externalId },
        },
        create: {
          organizationId,
          storeId,
          externalId: item.externalId,
          sku: item.sku,
          title: item.title,
          brand: item.brand ?? null,
          barcode: item.barcode ?? null,
          category: item.category ?? null,
          returnRatePct: item.returnRatePct ?? 0,
          stockQty: item.stockQty ?? null,
          costPrice: item.costPrice,
          salePrice: item.salePrice,
          commissionRate: item.commissionRate,
          shippingCost: item.shippingCost,
          isActive: listed,
        },
        update: {
          title: item.title,
          brand: item.brand ?? undefined,
          barcode: item.barcode ?? undefined,
          category: item.category ?? undefined,
          returnRatePct: item.returnRatePct ?? undefined,
          stockQty: item.stockQty ?? undefined,
          costPrice: item.costPrice,
          salePrice: item.salePrice,
          // Komisyon: tarife / manuel oran korunur; katalog varsayılanı ezmesin
          shippingCost: item.shippingCost,
          isActive: listed,
        },
      });
      // create sonrası productMap rate — güncel DB değeri
      const rateAfter = Number(product.commissionRate);
      productMap.set(item.externalId, {
        id: product.id,
        cost: Number(product.costPrice),
        rate: rateAfter,
        ship: Number(product.shippingCost),
      });
    }

    // Çekimde gelmeyen (silinen/arşiv) ürünleri pasifleştir — şişkin katalogu önler
    if (seenExternalIds.size > 0) {
      await this.prisma.product.updateMany({
        where: {
          storeId,
          organizationId,
          isActive: true,
          externalId: { notIn: [...seenExternalIds] },
        },
        data: { isActive: false },
      });
    }

    // Kategori tarifelerini varsayılan (%12/%13) ürünlere uygula; özel oranları bozma
    await this.applyCategoryTariffs(organizationId, storeId, store.marketplace);

    // productMap oranlarını tarife sonrası tek sorguda tazele
    const refreshed = await this.prisma.product.findMany({
      where: { storeId, externalId: { in: [...seenExternalIds] } },
      select: {
        id: true,
        externalId: true,
        costPrice: true,
        commissionRate: true,
        shippingCost: true,
      },
    });
    productMap.clear();
    for (const p of refreshed) {
      productMap.set(p.externalId, {
        id: p.id,
        cost: Number(p.costPrice),
        rate: Number(p.commissionRate),
        ship: Number(p.shippingCost),
      });
    }

    let orderCount = 0;
    for (const row of pulled.orders) {
      const product = productMap.get(row.productExternalId);
      if (!product) continue;

      const qty = row.quantity;
      const sale = row.unitPrice;
      const gross = sale * qty;
      const commission = gross * product.rate;
      const shipping = product.ship;
      const serviceFee = Math.max(4, gross * 0.015);
      const vatNet = gross * 0.02;
      const withholding = gross * 0.01;
      const costTotal = product.cost * qty;
      const profit = calculateNetProfit({
        grossAmount: gross,
        commission,
        shippingFee: shipping,
        serviceFee,
        vatNet,
        withholding,
        costTotal,
      });

      await this.prisma.order.upsert({
        where: {
          storeId_externalId: { storeId, externalId: row.externalId },
        },
        create: {
          organizationId,
          storeId,
          externalId: row.externalId,
          status: row.status,
          orderedAt: new Date(row.orderedAt),
          grossAmount: profit.grossAmount,
          commission: profit.commission,
          shippingFee: profit.shippingFee,
          serviceFee: profit.serviceFee,
          vatNet: profit.vatNet,
          withholding: profit.withholding,
          costTotal: profit.costTotal,
          netProfit: profit.netProfit,
          items: {
            create: {
              productId: product.id,
              quantity: qty,
              unitPrice: sale,
              unitCost: product.cost,
              netProfit: profit.netProfit,
            },
          },
        },
        update: {
          status: row.status,
          netProfit: profit.netProfit,
          grossAmount: profit.grossAmount,
        },
      });
      orderCount += 1;
    }

    await this.prisma.store.update({
      where: { id: storeId },
      data: { lastSyncAt: new Date(), isConnected: true },
    });

    await this.notifications.emitEvent(organizationId, {
      dedupeKey: `sync:${storeId}:${new Date().toISOString().slice(0, 10)}`,
      title: "Senkron tamam",
      body: `${pulled.products.length} ürün, ${orderCount} sipariş güncellendi.`,
      tone: "profit",
      href: "/orders",
      actionLabel: "Siparişleri gör",
    });
    await this.notifications.scanOrganization(organizationId);

    return {
      products: pulled.products.length,
      orders: orderCount,
      source: pulled.source,
      message: pulled.note,
    };
  }

  /**
   * Senkron sonrası oran basımı: barkod → marka → kategori.
   */
  private async applyCategoryTariffs(
    organizationId: string,
    storeId: string,
    marketplace: string,
  ) {
    const mp = marketplace as "TRENDYOL" | "HEPSIBURADA";
    const [tariffs, barcodeRows, brandRows, products] = await Promise.all([
      this.prisma.commissionTariff.findMany({
        where: { organizationId, marketplace: mp },
        select: { category: true, rate: true },
      }),
      this.prisma.commissionBarcodeRate.findMany({
        where: { organizationId, marketplace: mp },
        select: { barcode: true, rate: true },
      }),
      this.prisma.commissionBrandRate.findMany({
        where: { organizationId, marketplace: mp },
        select: { brand: true, rate: true },
      }),
      this.prisma.product.findMany({
        where: { organizationId, storeId, isActive: true },
        select: {
          id: true,
          barcode: true,
          brand: true,
          category: true,
          commissionRate: true,
        },
      }),
    ]);

    const barcodeRate = new Map(
      barcodeRows.map((r) => [r.barcode, Number(r.rate)]),
    );
    const brandRate = new Map(
      brandRows.map((r) => [r.brand.trim().toLowerCase(), Number(r.rate)]),
    );
    const tariffByCat = new Map(
      tariffs.map((t) => [t.category.trim().toLowerCase(), Number(t.rate)]),
    );

    for (const p of products) {
      let rate: number | null = null;
      if (p.barcode && barcodeRate.has(p.barcode)) {
        rate = barcodeRate.get(p.barcode)!;
      } else if (p.brand && brandRate.has(p.brand.trim().toLowerCase())) {
        rate = brandRate.get(p.brand.trim().toLowerCase())!;
      } else if (p.category) {
        rate =
          tariffByCat.get(p.category.trim().toLowerCase()) ??
          tariffByCat.get("diğer") ??
          null;
      }
      if (rate == null) continue;
      if (Math.abs(Number(p.commissionRate) - rate) <= 0.0005) continue;
      await this.prisma.product.update({
        where: { id: p.id },
        data: { commissionRate: rate },
      });
    }
  }

  /** Anahtarları pazaryeri çekimiyle dener */
  async validateCredentials(organizationId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, organizationId },
    });
    if (!store) throw new NotFoundException("Mağaza bulunamadı");

    const apiKey = decryptCredential(store.apiKeyEncrypted);
    if (!apiKey) {
      return {
        ok: false,
        source: "none" as const,
        products: 0,
        orders: 0,
        message: "API anahtarı eksik. Bağlantıyı yeniden kaydedin.",
      };
    }

    try {
      const adapter = this.marketplaces.get(store.marketplace as MarketplaceCode);
      const pulled = await adapter.pull(
        {
          apiKey,
          apiSecret: decryptCredential(store.apiSecretEncrypted),
          externalStoreId: store.externalStoreId,
        },
        { sinceDays: 1 },
      );

      await this.prisma.store.update({
        where: { id: storeId },
        data: { isConnected: pulled.source === "live" },
      });

      return {
        ok: pulled.source === "live",
        source: pulled.source,
        products: pulled.products.length,
        orders: pulled.orders.length,
        message:
          pulled.source === "live"
            ? "Bağlantı doğrulandı."
            : "Canlı uç yanıt vermedi. Anahtarları kontrol edin.",
      };
    } catch (err) {
      await this.prisma.store.update({
        where: { id: storeId },
        data: { isConnected: false },
      });
      return {
        ok: false,
        source: "none" as const,
        products: 0,
        orders: 0,
        message:
          err instanceof MarketplacePullError
            ? err.message
            : "Bağlantı doğrulanamadı. Anahtarları kontrol edin.",
      };
    }
  }
}
