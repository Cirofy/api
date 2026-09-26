import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MarketplaceRegistry } from "../marketplace/marketplace.registry";
import { decryptCredential } from "../marketplace/credential-crypto";
import {
  aggregateByBarcode,
  aggregateByBrand,
  aggregateByCategory,
  type PulledCommissionRate,
} from "../marketplace/commission-rates";
import { MarketplacePullError } from "../marketplace/pull-error";
import type { MarketplaceCode } from "../marketplace/marketplace.types";
import type {
  ApplyTariffDto,
  ImportTariffsDto,
  UpsertTariffDto,
  UpsertTariffOverrideDto,
} from "./dto";

export type TariffAuditCtx = {
  userId?: string | null;
  ip?: string | null;
};

const DEFAULT_TARIFFS: Array<{
  marketplace: "TRENDYOL" | "HEPSIBURADA";
  category: string;
  rate: number;
  plusRate: number;
  note: string;
}> = [
  {
    marketplace: "TRENDYOL",
    category: "Elektronik",
    rate: 0.12,
    plusRate: 0.145,
    note: "Kanal tablosu · elektronik",
  },
  {
    marketplace: "TRENDYOL",
    category: "Ev & Yaşam",
    rate: 0.135,
    plusRate: 0.16,
    note: "Kanal tablosu · ev",
  },
  {
    marketplace: "TRENDYOL",
    category: "Moda",
    rate: 0.15,
    plusRate: 0.175,
    note: "Kanal tablosu · moda",
  },
  {
    marketplace: "TRENDYOL",
    category: "Kozmetik",
    rate: 0.14,
    plusRate: 0.165,
    note: "Kanal tablosu · kozmetik",
  },
  {
    marketplace: "TRENDYOL",
    category: "Spor",
    rate: 0.13,
    plusRate: 0.155,
    note: "Kanal tablosu · spor",
  },
  {
    marketplace: "TRENDYOL",
    category: "Süpermarket",
    rate: 0.11,
    plusRate: 0.13,
    note: "Kanal tablosu · market",
  },
  {
    marketplace: "TRENDYOL",
    category: "Diğer",
    rate: 0.12,
    plusRate: 0.14,
    note: "Kanal tablosu · varsayılan",
  },
  {
    marketplace: "HEPSIBURADA",
    category: "Elektronik",
    rate: 0.13,
    plusRate: 0.155,
    note: "Kanal tablosu · elektronik",
  },
  {
    marketplace: "HEPSIBURADA",
    category: "Ev & Yaşam",
    rate: 0.14,
    plusRate: 0.165,
    note: "Kanal tablosu · ev",
  },
  {
    marketplace: "HEPSIBURADA",
    category: "Moda",
    rate: 0.155,
    plusRate: 0.18,
    note: "Kanal tablosu · moda",
  },
  {
    marketplace: "HEPSIBURADA",
    category: "Kozmetik",
    rate: 0.145,
    plusRate: 0.17,
    note: "Kanal tablosu · kozmetik",
  },
  {
    marketplace: "HEPSIBURADA",
    category: "Diğer",
    rate: 0.13,
    plusRate: 0.15,
    note: "Kanal tablosu · varsayılan",
  },
];

function catalogFor(
  marketplace: "TRENDYOL" | "HEPSIBURADA",
  category: string,
) {
  const cat = category.trim();
  const exact = DEFAULT_TARIFFS.find(
    (t) =>
      t.marketplace === marketplace &&
      t.category.toLowerCase() === cat.toLowerCase(),
  );
  if (exact) return exact;
  const fallback = DEFAULT_TARIFFS.find(
    (t) => t.marketplace === marketplace && t.category === "Diğer",
  );
  return (
    fallback ?? {
      marketplace,
      category: cat || "Diğer",
      rate: marketplace === "HEPSIBURADA" ? 0.13 : 0.12,
      plusRate: marketplace === "HEPSIBURADA" ? 0.15 : 0.14,
      note: "Kanal varsayılanı",
    }
  );
}

@Injectable()
export class TariffsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notifications: NotificationsService,
    private readonly marketplaces: MarketplaceRegistry,
  ) {}

  async list(organizationId: string) {
    const [rows, overrides, categories, stores] = await Promise.all([
      this.prisma.commissionTariff.findMany({
        where: { organizationId },
        orderBy: [{ marketplace: "asc" }, { category: "asc" }],
      }),
      this.prisma.commissionTariffOverride.findMany({
        where: { organizationId },
        include: {
          store: { select: { id: true, name: true, marketplace: true } },
        },
        orderBy: [{ storeId: "asc" }, { category: "asc" }],
      }),
      this.prisma.product.findMany({
        where: { organizationId, isActive: true },
        select: { category: true },
        distinct: ["category"],
        take: 80,
      }),
      this.prisma.store.findMany({
        where: { organizationId },
        select: { id: true, name: true, marketplace: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const productCategories = [
      ...new Set(
        [
          ...categories.map((c) => c.category?.trim()).filter(Boolean),
          ...rows.map((r) => r.category?.trim()).filter(Boolean),
          "Diğer",
        ] as string[],
      ),
    ].sort((a, b) => a.localeCompare(b, "tr"));

    return {
      items: rows.map(mapTariff),
      overrides: overrides.map(mapOverride),
      stores: stores.map((s) => ({
        id: s.id,
        name: s.name,
        marketplace:
          s.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        marketplaceCode: s.marketplace as "TRENDYOL" | "HEPSIBURADA",
      })),
      productCategories,
      source: rows.length > 0 ? ("catalog" as const) : ("empty" as const),
      note:
        rows.length > 0
          ? "Kategori × kanal tarifesi. Mağaza override org varsayılanını ezer."
          : "Henüz tarife yok — Senkron ile katalog tarifelerini oluşturun.",
    };
  }

  async listHistory(organizationId: string, take = 40) {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { startsWith: "tariff." } },
      orderBy: { createdAt: "desc" },
      take: Math.min(100, Math.max(1, take)) * 3,
      include: {
        user: { select: { fullName: true, email: true } },
      },
    });
    const items = rows
      .filter((r) => {
        const meta = r.meta as { orgId?: string } | null;
        return meta?.orgId === organizationId;
      })
      .slice(0, take)
      .map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        meta: (r.meta ?? {}) as Record<string, unknown>,
        actor: r.user?.fullName || r.user?.email || null,
        createdAt: r.createdAt.toISOString(),
        label: tariffActionLabel(r.action),
      }));
    return {
      items,
      total: items.length,
      message:
        items.length > 0
          ? `${items.length} tarife kaydı.`
          : "Henüz tarife geçmişi yok.",
    };
  }

  async upsert(
    organizationId: string,
    dto: UpsertTariffDto,
    ctx?: TariffAuditCtx,
  ) {
    const category = dto.category.trim();
    const rate = normalizeRate(dto.rate);
    const plusRate =
      dto.plusRate != null
        ? normalizeRate(dto.plusRate)
        : round4(rate + 0.025);
    const before = await this.prisma.commissionTariff.findUnique({
      where: {
        organizationId_marketplace_category: {
          organizationId,
          marketplace: dto.marketplace,
          category,
        },
      },
    });
    const row = await this.prisma.commissionTariff.upsert({
      where: {
        organizationId_marketplace_category: {
          organizationId,
          marketplace: dto.marketplace,
          category,
        },
      },
      create: {
        organizationId,
        marketplace: dto.marketplace,
        category,
        rate,
        plusRate,
        note: dto.note?.trim() || null,
      },
      update: {
        rate,
        plusRate,
        note: dto.note?.trim() || null,
      },
    });
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.upsert",
      entityType: "CommissionTariff",
      entityId: row.id,
      meta: {
        marketplace: dto.marketplace,
        category,
        before: before
          ? {
              ratePct: round2(Number(before.rate) * 100),
              plusRatePct: round2(Number(before.plusRate) * 100),
            }
          : null,
        after: {
          ratePct: round2(Number(row.rate) * 100),
          plusRatePct: round2(Number(row.plusRate) * 100),
        },
      },
    });
    await this.notifyTariffChange(organizationId, {
      title: "Tarife güncellendi",
      body: `${category} · ${dto.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol"} · %${round2(Number(row.rate) * 100)} (Plus %${round2(Number(row.plusRate) * 100)})`,
      dedupeKey: `tariff:change:${dto.marketplace}:${category}:${new Date().toISOString().slice(0, 10)}`,
    });
    return {
      item: mapTariff(row),
      message: "Tarife kaydedildi.",
    };
  }

  async importRows(
    organizationId: string,
    dto: ImportTariffsDto,
    ctx?: TariffAuditCtx,
  ) {
    const rows = dto.rows ?? [];
    if (rows.length === 0) {
      return { upserted: 0, skipped: 0, message: "Satır yok." };
    }
    let upserted = 0;
    let skipped = 0;
    for (const row of rows.slice(0, 500)) {
      const category = row.category?.trim();
      if (!category || row.rate == null || !row.marketplace) {
        skipped += 1;
        continue;
      }
      await this.upsert(
        organizationId,
        {
          marketplace: row.marketplace,
          category,
          rate: row.rate,
          plusRate: row.plusRate,
          note: row.note,
        },
        undefined,
      );
      upserted += 1;
    }
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.import",
      entityType: "CommissionTariff",
      entityId: null,
      meta: { upserted, skipped, rowCount: rows.length },
    });
    if (upserted > 0) {
      await this.notifyTariffChange(organizationId, {
        title: "Tarife CSV aktarıldı",
        body: `${upserted} kategori tarifesi güncellendi.`,
        dedupeKey: `tariff:import:${new Date().toISOString().slice(0, 10)}`,
      });
    }
    return {
      upserted,
      skipped,
      message:
        upserted > 0
          ? `${upserted} tarife içe aktarıldı${skipped ? ` · ${skipped} satır atlandı` : ""}.`
          : "İçe aktarılacak satır yok.",
    };
  }

  async remove(
    organizationId: string,
    id: string,
    ctx?: TariffAuditCtx,
  ) {
    const existing = await this.prisma.commissionTariff.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException("Tarife bulunamadı");
    await this.prisma.commissionTariff.delete({ where: { id } });
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.delete",
      entityType: "CommissionTariff",
      entityId: id,
      meta: {
        marketplace: existing.marketplace,
        category: existing.category,
        ratePct: round2(Number(existing.rate) * 100),
      },
    });
    await this.notifyTariffChange(organizationId, {
      title: "Tarife silindi",
      body: `${existing.category} tarifesi kaldırıldı.`,
      dedupeKey: `tariff:delete:${existing.marketplace}:${existing.category}:${new Date().toISOString().slice(0, 10)}`,
    });
    return { removed: true, message: `${existing.category} tarifesi silindi.` };
  }

  async upsertOverride(
    organizationId: string,
    dto: UpsertTariffOverrideDto,
    ctx?: TariffAuditCtx,
  ) {
    const store = await this.prisma.store.findFirst({
      where: { id: dto.storeId, organizationId },
    });
    if (!store) throw new NotFoundException("Mağaza bulunamadı");
    const category = dto.category.trim();
    const rate = normalizeRate(dto.rate);
    const plusRate =
      dto.plusRate != null
        ? normalizeRate(dto.plusRate)
        : round4(rate + 0.025);
    const row = await this.prisma.commissionTariffOverride.upsert({
      where: {
        storeId_category: { storeId: dto.storeId, category },
      },
      create: {
        organizationId,
        storeId: dto.storeId,
        category,
        rate,
        plusRate,
        note: dto.note?.trim() || null,
      },
      update: {
        rate,
        plusRate,
        note: dto.note?.trim() || null,
      },
      include: {
        store: { select: { id: true, name: true, marketplace: true } },
      },
    });
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.override_upsert",
      entityType: "CommissionTariffOverride",
      entityId: row.id,
      meta: {
        storeId: dto.storeId,
        storeName: store.name,
        category,
        ratePct: round2(rate * 100),
        plusRatePct: round2(plusRate * 100),
      },
    });
    await this.notifyTariffChange(organizationId, {
      title: "Mağaza tarife override",
      body: `${store.name} · ${category} · %${round2(rate * 100)}`,
      dedupeKey: `tariff:override:${dto.storeId}:${category}:${new Date().toISOString().slice(0, 10)}`,
    });
    return {
      item: mapOverride(row),
      message: "Mağaza override kaydedildi.",
    };
  }

  async removeOverride(
    organizationId: string,
    id: string,
    ctx?: TariffAuditCtx,
  ) {
    const existing = await this.prisma.commissionTariffOverride.findFirst({
      where: { id, organizationId },
      include: { store: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundException("Override bulunamadı");
    await this.prisma.commissionTariffOverride.delete({ where: { id } });
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.override_delete",
      entityType: "CommissionTariffOverride",
      entityId: id,
      meta: {
        storeId: existing.storeId,
        category: existing.category,
      },
    });
    return {
      removed: true,
      message: `${existing.store.name} · ${existing.category} override silindi.`,
    };
  }

  async apply(
    organizationId: string,
    dto: ApplyTariffDto,
    ctx?: TariffAuditCtx,
  ) {
    let tariff = dto.id
      ? await this.prisma.commissionTariff.findFirst({
          where: { id: dto.id, organizationId },
        })
      : null;

    if (!tariff && dto.marketplace && dto.category) {
      tariff = await this.prisma.commissionTariff.findUnique({
        where: {
          organizationId_marketplace_category: {
            organizationId,
            marketplace: dto.marketplace,
            category: dto.category.trim(),
          },
        },
      });
    }

    if (!tariff) {
      throw new NotFoundException("Uygulanacak tarife bulunamadı");
    }

    const rate = dto.usePlus ? Number(tariff.plusRate) : Number(tariff.rate);

    // Kategori uygula: barkod/marka canlı oranı olan ürünleri ezme
    const [barcodeRows, brandRows] = await Promise.all([
      this.prisma.commissionBarcodeRate.findMany({
        where: { organizationId, marketplace: tariff.marketplace },
        select: { barcode: true },
      }),
      this.prisma.commissionBrandRate.findMany({
        where: { organizationId, marketplace: tariff.marketplace },
        select: { brand: true },
      }),
    ]);
    const barcodeSet = new Set(barcodeRows.map((r) => r.barcode));
    const brandSet = new Set(brandRows.map((r) => r.brand.trim().toLowerCase()));

    const candidates = await this.prisma.product.findMany({
      where: {
        organizationId,
        category: { equals: tariff.category, mode: "insensitive" },
        store: {
          marketplace: tariff.marketplace,
          ...(dto.storeId ? { id: dto.storeId } : {}),
        },
      },
      select: { id: true, barcode: true, brand: true },
    });

    const ids = candidates
      .filter((p) => {
        if (p.barcode && barcodeSet.has(p.barcode)) return false;
        if (p.brand && brandSet.has(p.brand.trim().toLowerCase())) return false;
        return true;
      })
      .map((p) => p.id);

    const result =
      ids.length === 0
        ? { count: 0 }
        : await this.prisma.product.updateMany({
            where: { id: { in: ids } },
            data: { commissionRate: rate },
          });

    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.apply",
      entityType: "CommissionTariff",
      entityId: tariff.id,
      meta: {
        marketplace: tariff.marketplace,
        category: tariff.category,
        usePlus: Boolean(dto.usePlus),
        ratePct: round2(rate * 100),
        updated: result.count,
        skippedBarcodeOrBrand: candidates.length - result.count,
      },
    });

    return {
      updated: result.count,
      rate,
      ratePct: round2(rate * 100),
      usePlus: Boolean(dto.usePlus),
      marketplace: tariff.marketplace,
      category: tariff.category,
      message:
        result.count > 0
          ? `${result.count} ürüne %${round2(rate * 100)} komisyon uygulandı${dto.usePlus ? " (Plus)" : ""} (barkod/marka oranlı ürünler korundu).`
          : candidates.length > 0
            ? "Bu kategorideki ürünlerin hepsinde barkod veya marka oranı var; kategori uygulanmadı."
            : "Bu kategori/kanalda eşleşen ürün yok.",
    };
  }

  /** Ürün çözümleme: barkod → marka → mağaza override → kategori. */
  async resolveForProduct(
    organizationId: string,
    marketplace: "TRENDYOL" | "HEPSIBURADA",
    category: string | null | undefined,
    storeId?: string | null,
    opts?: { barcode?: string | null; brand?: string | null },
  ) {
    const cat = category?.trim() || "Diğer";
    const barcode = opts?.barcode?.trim() || null;
    const brand = opts?.brand?.trim() || null;

    if (barcode) {
      const byBarcode = await this.prisma.commissionBarcodeRate.findUnique({
        where: {
          organizationId_marketplace_barcode: {
            organizationId,
            marketplace,
            barcode,
          },
        },
      });
      if (byBarcode) return mapBarcodeRate(byBarcode, cat);
    }

    if (storeId) {
      const override = await this.prisma.commissionTariffOverride.findUnique({
        where: { storeId_category: { storeId, category: cat } },
        include: {
          store: { select: { id: true, name: true, marketplace: true } },
        },
      });
      if (override) return mapOverride(override);
      const fallbackOverride =
        await this.prisma.commissionTariffOverride.findUnique({
          where: { storeId_category: { storeId, category: "Diğer" } },
          include: {
            store: { select: { id: true, name: true, marketplace: true } },
          },
        });
      if (fallbackOverride) return mapOverride(fallbackOverride);
    }

    if (brand) {
      const byBrand = await this.prisma.commissionBrandRate.findFirst({
        where: {
          organizationId,
          marketplace,
          brand: { equals: brand, mode: "insensitive" },
        },
      });
      if (byBrand) return mapBrandRate(byBrand, cat);
    }

    const exact = await this.prisma.commissionTariff.findUnique({
      where: {
        organizationId_marketplace_category: {
          organizationId,
          marketplace,
          category: cat,
        },
      },
    });
    if (exact) return mapTariff(exact);

    const fallback = await this.prisma.commissionTariff.findUnique({
      where: {
        organizationId_marketplace_category: {
          organizationId,
          marketplace,
          category: "Diğer",
        },
      },
    });
    return fallback ? mapTariff(fallback) : null;
  }

  async resolveByProductId(organizationId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId },
      select: {
        id: true,
        sku: true,
        title: true,
        barcode: true,
        brand: true,
        category: true,
        commissionRate: true,
        store: { select: { id: true, marketplace: true } },
      },
    });
    if (!product) throw new NotFoundException("Ürün bulunamadı");
    return this.buildResolvePayload(organizationId, product);
  }

  /** Eklenti / buybox yakalaması: SKU (+ isteğe bağlı kanal) ile tarife. */
  async resolveBySku(
    organizationId: string,
    sku: string,
    marketplaceRaw?: string,
  ) {
    const skuTrim = sku.trim();
    if (!skuTrim) {
      return {
        product: null,
        tariff: null,
        mismatch: false,
        message: "SKU gerekli",
      };
    }
    const marketplaceCode = normalizeMarketplaceCode(marketplaceRaw);
    const select = {
      id: true,
      sku: true,
      title: true,
      barcode: true,
      brand: true,
      category: true,
      commissionRate: true,
      store: { select: { id: true, marketplace: true as const } },
    };
    let product = await this.prisma.product.findFirst({
      where: {
        organizationId,
        sku: skuTrim,
        ...(marketplaceCode
          ? { store: { marketplace: marketplaceCode } }
          : {}),
      },
      select,
    });
    if (!product && marketplaceCode) {
      product = await this.prisma.product.findFirst({
        where: { organizationId, sku: skuTrim },
        select,
      });
    }
    if (!product) {
      return {
        product: null,
        tariff: null,
        mismatch: false,
        message: "Bu SKU katalogda yok — ürün senkronu sonrası tarife bağlanır.",
      };
    }
    return this.buildResolvePayload(organizationId, product);
  }

  private async buildResolvePayload(
    organizationId: string,
    product: {
      id: string;
      sku: string | null;
      title: string;
      barcode?: string | null;
      brand?: string | null;
      category: string | null;
      commissionRate: unknown;
      store: { id: string; marketplace: "TRENDYOL" | "HEPSIBURADA" };
    },
  ) {
    const marketplace = product.store.marketplace;
    const tariff = await this.resolveForProduct(
      organizationId,
      marketplace,
      product.category,
      product.store.id,
      { barcode: product.barcode, brand: product.brand },
    );
    const currentRate = Number(product.commissionRate);
    const sourceLabel =
      tariff && "rateSource" in tariff && tariff.rateSource
        ? tariff.rateSource === "barcode"
          ? "barkod"
          : tariff.rateSource === "brand"
            ? "marka"
            : tariff.rateSource === "override"
              ? "override"
              : "kategori"
        : null;
    return {
      product: {
        id: product.id,
        sku: product.sku,
        title: product.title,
        category: product.category,
        marketplace:
          marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        marketplaceCode: marketplace,
        storeId: product.store.id,
        currentRate,
        currentRatePct: round2(currentRate * 100),
      },
      tariff,
      mismatch:
        tariff != null && Math.abs(tariff.rate - currentRate) > 0.0005,
      message: tariff
        ? `Öneri: %${tariff.ratePct} (${tariff.category} · ${tariff.marketplace}${
            sourceLabel ? ` · ${sourceLabel}` : ""
          }${
            "isOverride" in tariff && tariff.isOverride ? " · override" : ""
          })`
        : "Bu kategori için tarife yok.",
    };
  }

  async applyToProduct(
    organizationId: string,
    productId: string,
    usePlus = false,
    ctx?: TariffAuditCtx,
  ) {
    const resolved = await this.resolveByProductId(organizationId, productId);
    if (!resolved.tariff) {
      throw new NotFoundException("Uygulanacak tarife bulunamadı");
    }
    const rate = usePlus ? resolved.tariff.plusRate : resolved.tariff.rate;
    await this.prisma.product.update({
      where: { id: productId },
      data: { commissionRate: rate },
    });
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.apply_product",
      entityType: "Product",
      entityId: productId,
      meta: {
        sku: resolved.product.sku,
        usePlus,
        ratePct: round2(rate * 100),
        fromPct: resolved.product.currentRatePct,
      },
    });
    return {
      updated: 1,
      productId,
      rate,
      ratePct: round2(rate * 100),
      usePlus,
      message: `Komisyon %${round2(rate * 100)} olarak güncellendi${usePlus ? " (Plus)" : ""}.`,
    };
  }

  /** Tarifeden sapmış ürünler (barkod → marka → kategori önerisi). */
  async listMismatches(organizationId: string, scanCap = 100) {
    const cap = Math.max(1, Math.min(50_000, Math.floor(scanCap)));
    const [products, tariffs, overrides, barcodeRates, brandRates, activeProductCount] =
      await Promise.all([
      this.prisma.product.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          sku: true,
          title: true,
          barcode: true,
          brand: true,
          category: true,
          commissionRate: true,
          store: { select: { id: true, marketplace: true } },
        },
        take: cap,
        orderBy: { title: "asc" },
      }),
      this.prisma.commissionTariff.findMany({
        where: { organizationId },
      }),
      this.prisma.commissionTariffOverride.findMany({
        where: { organizationId },
      }),
      this.prisma.commissionBarcodeRate.findMany({
        where: { organizationId },
      }),
      this.prisma.commissionBrandRate.findMany({
        where: { organizationId },
      }),
      this.prisma.product.count({
        where: { organizationId, isActive: true },
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
    const overrideByKey = new Map(
      overrides.map((o) => [
        `${o.storeId}::${o.category.trim().toLowerCase()}`,
        o,
      ]),
    );
    const overrideFallbackByStore = new Map(
      overrides
        .filter((o) => o.category.trim().toLowerCase() === "diğer")
        .map((o) => [o.storeId, o]),
    );
    const barcodeByKey = new Map(
      barcodeRates.map((r) => [`${r.marketplace}::${r.barcode}`, r]),
    );
    const brandByKey = new Map(
      brandRates.map((r) => [
        `${r.marketplace}::${r.brand.trim().toLowerCase()}`,
        r,
      ]),
    );

    const items: Array<{
      productId: string;
      sku: string | null;
      title: string;
      category: string | null;
      marketplace: string;
      marketplaceCode: "TRENDYOL" | "HEPSIBURADA";
      currentRatePct: number;
      suggestedRatePct: number;
      suggestedPlusRatePct: number;
      tariffCategory: string;
      deltaPct: number;
      isOverride: boolean;
      rateSource: "barcode" | "brand" | "override" | "category";
    }> = [];

    for (const p of products) {
      const marketplace = p.store.marketplace;
      const cat = p.category?.trim();
      if (!cat) continue;

      const barcodeHit =
        p.barcode != null
          ? barcodeByKey.get(`${marketplace}::${p.barcode}`)
          : undefined;
      const brandHit =
        p.brand != null
          ? brandByKey.get(`${marketplace}::${p.brand.trim().toLowerCase()}`)
          : undefined;
      const ov =
        overrideByKey.get(`${p.store.id}::${cat.toLowerCase()}`) ??
        overrideFallbackByStore.get(p.store.id);
      const exact = byKey.get(`${marketplace}::${cat.toLowerCase()}`);
      const base = exact ?? fallbackByMarket.get(marketplace);

      let suggested: number | null = null;
      let suggestedPlus: number | null = null;
      let tariffCategory = cat;
      let isOverride = false;
      let rateSource: "barcode" | "brand" | "override" | "category" = "category";

      if (barcodeHit) {
        suggested = Number(barcodeHit.rate);
        suggestedPlus = Number(barcodeHit.plusRate);
        rateSource = "barcode";
        tariffCategory = `${cat} · barkod`;
      } else if (ov) {
        suggested = Number(ov.rate);
        suggestedPlus = Number(ov.plusRate);
        isOverride = true;
        rateSource = "override";
        tariffCategory = ov.category;
      } else if (brandHit) {
        suggested = Number(brandHit.rate);
        suggestedPlus = Number(brandHit.plusRate);
        rateSource = "brand";
        tariffCategory = `${cat} · ${p.brand}`;
      } else if (base) {
        suggested = Number(base.rate);
        suggestedPlus = Number(base.plusRate);
        rateSource = "category";
        tariffCategory = base.category;
      }

      if (suggested == null || suggestedPlus == null) continue;
      const current = Number(p.commissionRate);
      if (Math.abs(suggested - current) <= 0.0005) continue;

      items.push({
        productId: p.id,
        sku: p.sku,
        title: p.title,
        category: p.category,
        marketplace:
          marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        marketplaceCode: marketplace,
        currentRatePct: round2(current * 100),
        suggestedRatePct: round2(suggested * 100),
        suggestedPlusRatePct: round2(suggestedPlus * 100),
        tariffCategory,
        deltaPct: round2((suggested - current) * 100),
        isOverride,
        rateSource,
      });
    }

    const scanCapped = activeProductCount > cap;
    return {
      items,
      total: items.length,
      scanned: products.length,
      scanCap: cap,
      activeProductCount,
      scanCapped,
      truncated: scanCapped,
      message:
        items.length > 0
          ? `${items.length} ürün tarifeden sapıyor${
              scanCapped
                ? ` (tarama kotası ${cap}/${activeProductCount} ürün)`
                : ""
            }.`
          : scanCapped
            ? `Taranan ${cap} ürün tarifeyle uyumlu; ${activeProductCount - cap} ürün kotada taranamadı.`
            : "Tarifeyle uyumlu — sapma yok.",
    };
  }

  async applyMismatches(
    organizationId: string,
    productIds: string[] | undefined,
    usePlus = false,
    scanCap = 500,
    ctx?: TariffAuditCtx,
    onlyOverrides = false,
  ) {
    const { items } = await this.listMismatches(organizationId, scanCap);
    const allow = productIds?.length ? new Set(productIds) : null;
    let targets = allow
      ? items.filter((i) => allow.has(i.productId))
      : items;
    if (onlyOverrides) {
      targets = targets.filter((i) => i.isOverride);
    }

    let updated = 0;
    for (const row of targets) {
      const ratePct = usePlus ? row.suggestedPlusRatePct : row.suggestedRatePct;
      await this.prisma.product.update({
        where: { id: row.productId },
        data: { commissionRate: ratePct / 100 },
      });
      updated += 1;
    }

    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.apply_mismatches",
      entityType: "Product",
      entityId: null,
      meta: {
        updated,
        usePlus,
        onlyOverrides,
        requested: targets.length,
      },
    });

    return {
      updated,
      usePlus,
      onlyOverrides,
      message:
        updated > 0
          ? `${updated} ürün komisyonu tarifeye çekildi${usePlus ? " (Plus)" : ""}${
              onlyOverrides ? " · yalnız override" : ""
            }.`
          : onlyOverrides
            ? "Override sapması yok."
            : "Güncellenecek sapma yok.",
    };
  }

  async applyOverride(
    organizationId: string,
    overrideId: string,
    usePlus = false,
    ctx?: TariffAuditCtx,
  ) {
    const ov = await this.prisma.commissionTariffOverride.findFirst({
      where: { id: overrideId, organizationId },
      include: { store: { select: { name: true } } },
    });
    if (!ov) throw new NotFoundException("Override bulunamadı");
    const rate = usePlus ? Number(ov.plusRate) : Number(ov.rate);
    const result = await this.prisma.product.updateMany({
      where: {
        organizationId,
        storeId: ov.storeId,
        category: { equals: ov.category, mode: "insensitive" },
      },
      data: { commissionRate: rate },
    });
    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.apply_override",
      entityType: "CommissionTariffOverride",
      entityId: ov.id,
      meta: {
        storeId: ov.storeId,
        category: ov.category,
        usePlus,
        updated: result.count,
        ratePct: round2(rate * 100),
      },
    });
    return {
      updated: result.count,
      usePlus,
      message:
        result.count > 0
          ? `${ov.store.name} · ${ov.category}: ${result.count} ürüne %${round2(rate * 100)} uygulandı${usePlus ? " (Plus)" : ""}.`
          : "Bu override ile eşleşen ürün yok.",
    };
  }

  private async writeAudit(input: {
    organizationId: string;
    ctx?: TariffAuditCtx;
    action: string;
    entityType: string;
    entityId: string | null;
    meta: Record<string, unknown>;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.ctx?.userId || null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          ip: input.ctx?.ip || null,
          meta: {
            orgId: input.organizationId,
            ...input.meta,
          },
        },
      });
    } catch {
      // audit yazımı ürün akışını bozmaz
    }
  }

  private async notifyTariffChange(
    organizationId: string,
    input: { title: string; body: string; dedupeKey: string },
  ) {
    try {
      await this.notifications.emitEvent(organizationId, {
        dedupeKey: input.dedupeKey,
        title: input.title,
        body: input.body,
        tone: "warn",
        href: "/tariffs",
        actionLabel: "Tarifelere git",
      });
    } catch {
      // bildirim ürün akışını bozmaz
    }
    try {
      const pref = await this.prisma.reportMailPref.findUnique({
        where: { organizationId },
      });
      if (!pref?.tariffChange || !pref.email?.includes("@")) return;
      await this.mail.send({
        to: pref.email,
        subject: `Cirofy · ${input.title}`,
        text: `${input.body}\n\nTarifeleri incelemek için panele gidin.`,
      });
    } catch {
      // mail başarısızlığı sessiz
    }
  }

  /**
   * Bağlı mağazalardan gerçek komisyon oranlarını çeker.
   * TY: finance/che settlements (Sale) · HB: listing commissions.
   */
  async syncFromMarketplace(organizationId: string, ctx?: TariffAuditCtx) {
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
        "Önce Ayarlar’dan bir mağaza bağlayın; tarife çekimi mağaza anahtarı ister.",
      );
    }

    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        sku: true,
        barcode: true,
        brand: true,
        externalId: true,
        category: true,
        storeId: true,
        store: { select: { marketplace: true } },
      },
      take: 10000,
    });

    const pulled: PulledCommissionRate[] = [];
    const errors: string[] = [];
    const marketsHit: MarketplaceCode[] = [];

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

      const adapter = this.marketplaces.get(store.marketplace);
      if (!adapter.pullCommissionRates) {
        errors.push(`${store.name}: komisyon çekimi desteklenmiyor`);
        continue;
      }

      const catalog = products
        .filter((p) => p.storeId === store.id)
        .map((p) => ({
          sku: p.sku,
          barcode: p.barcode,
          category: p.category,
          externalId: p.externalId,
        }));

      try {
        const rows = await adapter.pullCommissionRates(
          {
            apiKey,
            apiSecret,
            externalStoreId: store.externalStoreId,
          },
          { sinceDays: 14, catalog },
        );
        pulled.push(...rows);
        marketsHit.push(store.marketplace);
      } catch (err) {
        const msg =
          err instanceof MarketplacePullError || err instanceof BadRequestException
            ? err.message
            : "Komisyon çekilemedi";
        errors.push(`${store.name}: ${msg}`);
      }
    }

    if (pulled.length === 0) {
      throw new BadRequestException(
        errors.length
          ? `Canlı komisyon alınamadı. ${errors.join(" · ")}`
          : "Canlı komisyon satırı dönmedi. Önce ürün senkronu yapıp tekrar deneyin.",
      );
    }

    // Kategori eşlemesi zayıf kalan TY barkodlarını ürün tablosundan zenginleştir
    const barcodeToCat = new Map<string, string>();
    const skuToCat = new Map<string, string>();
    for (const p of products) {
      const cat = (p.category || "Diğer").trim() || "Diğer";
      if (p.barcode) barcodeToCat.set(p.barcode.trim(), cat);
      if (p.sku) skuToCat.set(p.sku.trim(), cat);
      if (p.externalId) skuToCat.set(p.externalId.trim(), cat);
    }
    for (const row of pulled) {
      if (row.category === "Diğer") {
        const richer =
          (row.barcode && barcodeToCat.get(row.barcode)) ||
          (row.sku && skuToCat.get(row.sku));
        if (richer) row.category = richer;
      }
    }

    const aggregated = aggregateByCategory(pulled);
    let upserted = 0;
    for (const row of aggregated.values()) {
      await this.prisma.commissionTariff.upsert({
        where: {
          organizationId_marketplace_category: {
            organizationId,
            marketplace: row.marketplace,
            category: row.category,
          },
        },
        create: {
          organizationId,
          marketplace: row.marketplace,
          category: row.category,
          rate: row.rate,
          plusRate: row.plusRate,
          note: row.note,
        },
        update: {
          rate: row.rate,
          plusRate: row.plusRate,
          note: row.note,
        },
      });
      upserted += 1;
    }

    // Barkod oranları (ürün seviyesi)
    const byBarcode = aggregateByBarcode(pulled);
    let barcodeUpserted = 0;
    for (const row of byBarcode.values()) {
      await this.prisma.commissionBarcodeRate.upsert({
        where: {
          organizationId_marketplace_barcode: {
            organizationId,
            marketplace: row.marketplace,
            barcode: row.barcode,
          },
        },
        create: {
          organizationId,
          marketplace: row.marketplace,
          barcode: row.barcode,
          rate: row.rate,
          plusRate: row.plusRate,
          sampleCount: row.sampleCount,
          note: `Hakediş · ${row.sampleCount} örnek`,
        },
        update: {
          rate: row.rate,
          plusRate: row.plusRate,
          sampleCount: row.sampleCount,
          note: `Hakediş · ${row.sampleCount} örnek`,
        },
      });
      barcodeUpserted += 1;
    }

    // Marka medyanı (HP %13,5 vb.) — barkod→ürün markası
    const barcodeToBrand = new Map<string, string>();
    for (const p of products) {
      if (p.barcode?.trim() && p.brand?.trim()) {
        barcodeToBrand.set(p.barcode.trim(), p.brand.trim());
      }
    }
    // products may be capped — load more barcodes for brand mapping
    if (barcodeToBrand.size < byBarcode.size) {
      const extra = await this.prisma.product.findMany({
        where: {
          organizationId,
          barcode: { in: [...byBarcode.values()].map((r) => r.barcode) },
        },
        select: { barcode: true, brand: true },
      });
      for (const p of extra) {
        if (p.barcode?.trim() && p.brand?.trim()) {
          barcodeToBrand.set(p.barcode.trim(), p.brand.trim());
        }
      }
    }

    const byBrand = aggregateByBrand([...byBarcode.values()], barcodeToBrand);
    // Eski / zayıf marka oranlarını temizle, yeniden yaz
    await this.prisma.commissionBrandRate.deleteMany({
      where: { organizationId },
    });
    let brandUpserted = 0;
    for (const row of byBrand.values()) {
      await this.prisma.commissionBrandRate.create({
        data: {
          organizationId,
          marketplace: row.marketplace,
          brand: row.brand,
          rate: row.rate,
          plusRate: row.plusRate,
          sampleCount: row.sampleCount,
          note: `Hakediş marka medyan · ${row.sampleCount} örnek`,
        },
      });
      brandUpserted += 1;
    }

    // Ürünlere uygula: barkod → marka → kategori
    const productsUpdated = await this.applyResolvedRatesToProducts(organizationId);

    await this.writeAudit({
      organizationId,
      ctx,
      action: "tariff.sync",
      entityType: "CommissionTariff",
      entityId: null,
      meta: {
        upserted,
        barcodeUpserted,
        brandUpserted,
        productsUpdated,
        sampleRows: pulled.length,
        markets: marketsHit,
        errors,
      },
    });

    const list = await this.list(organizationId);
    return {
      upserted,
      barcodeUpserted,
      brandUpserted,
      productsUpdated,
      sampleRows: pulled.length,
      markets: [...new Set(marketsHit)],
      items: list.items,
      productCategories: list.productCategories,
      source: "live" as const,
      warnings: errors,
      message:
        upserted > 0 || barcodeUpserted > 0
          ? `${upserted} kategori · ${barcodeUpserted} barkod · ${brandUpserted} marka tarifesi güncellendi; ${productsUpdated} ürüne uygulandı (${pulled.length} hakediş örneği).`
          : "Güncellenecek tarife yok.",
    };
  }

  /**
   * Canlı oran önceliği ile kataloga bas:
   * barkod > marka > kategori (varsayılan).
   */
  async applyResolvedRatesToProducts(
    organizationId: string,
    storeId?: string,
  ) {
    const [products, barcodeRates, brandRates, tariffs] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          organizationId,
          isActive: true,
          ...(storeId ? { storeId } : {}),
        },
        select: {
          id: true,
          barcode: true,
          brand: true,
          category: true,
          commissionRate: true,
          store: { select: { marketplace: true } },
        },
      }),
      this.prisma.commissionBarcodeRate.findMany({
        where: { organizationId },
      }),
      this.prisma.commissionBrandRate.findMany({
        where: { organizationId },
      }),
      this.prisma.commissionTariff.findMany({
        where: { organizationId },
      }),
    ]);

    const barcodeByKey = new Map(
      barcodeRates.map((r) => [`${r.marketplace}::${r.barcode}`, Number(r.rate)]),
    );
    const brandByKey = new Map(
      brandRates.map((r) => [
        `${r.marketplace}::${r.brand.trim().toLowerCase()}`,
        Number(r.rate),
      ]),
    );
    const tariffByKey = new Map(
      tariffs.map((t) => [
        `${t.marketplace}::${t.category.trim().toLowerCase()}`,
        Number(t.rate),
      ]),
    );

    let updated = 0;
    for (const p of products) {
      const mp = p.store.marketplace;
      let rate: number | null = null;
      if (p.barcode) {
        rate = barcodeByKey.get(`${mp}::${p.barcode}`) ?? null;
      }
      if (rate == null && p.brand) {
        rate =
          brandByKey.get(`${mp}::${p.brand.trim().toLowerCase()}`) ?? null;
      }
      if (rate == null && p.category) {
        rate =
          tariffByKey.get(`${mp}::${p.category.trim().toLowerCase()}`) ??
          tariffByKey.get(`${mp}::diğer`) ??
          null;
      }
      if (rate == null) continue;
      if (Math.abs(Number(p.commissionRate) - rate) <= 0.0005) continue;
      await this.prisma.product.update({
        where: { id: p.id },
        data: { commissionRate: rate },
      });
      updated += 1;
    }
    return updated;
  }
}

function tariffActionLabel(action: string) {
  switch (action) {
    case "tariff.upsert":
      return "Tarife kaydı";
    case "tariff.sync":
      return "Pazaryeri komisyonları çekildi";
    case "tariff.delete":
      return "Tarife silindi";
    case "tariff.apply":
      return "Kategoriye uygulandı";
    case "tariff.apply_product":
      return "Ürüne uygulandı";
    case "tariff.apply_mismatches":
      return "Sapmalar düzeltildi";
    case "tariff.import":
      return "CSV içe aktarma";
    case "tariff.override_upsert":
      return "Mağaza override";
    case "tariff.override_delete":
      return "Override silindi";
    case "tariff.apply_override":
      return "Override uygulandı";
    default:
      return action;
  }
}

function normalizeRate(raw: number) {
  if (raw > 1) return round4(raw / 100);
  return round4(raw);
}

function mapTariff(row: {
  id: string;
  marketplace: string;
  category: string;
  rate: unknown;
  plusRate: unknown;
  note: string | null;
  updatedAt: Date;
}) {
  const rate = Number(row.rate);
  const plusRate = Number(row.plusRate);
  return {
    id: row.id,
    marketplace: row.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
    marketplaceCode: row.marketplace as "TRENDYOL" | "HEPSIBURADA",
    category: row.category,
    rate,
    ratePct: round2(rate * 100),
    plusRate,
    plusRatePct: round2(plusRate * 100),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
    isOverride: false as const,
    storeId: null as string | null,
    storeName: null as string | null,
    rateSource: "category" as const,
  };
}

function mapBarcodeRate(
  row: {
    id: string;
    marketplace: string;
    barcode: string;
    rate: unknown;
    plusRate: unknown;
    note: string | null;
    updatedAt: Date;
  },
  category: string,
) {
  const rate = Number(row.rate);
  const plusRate = Number(row.plusRate);
  return {
    id: row.id,
    marketplace: row.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
    marketplaceCode: row.marketplace as "TRENDYOL" | "HEPSIBURADA",
    category,
    rate,
    ratePct: round2(rate * 100),
    plusRate,
    plusRatePct: round2(plusRate * 100),
    note: row.note ?? `Barkod ${row.barcode}`,
    updatedAt: row.updatedAt.toISOString(),
    isOverride: false as const,
    storeId: null as string | null,
    storeName: null as string | null,
    rateSource: "barcode" as const,
  };
}

function mapBrandRate(
  row: {
    id: string;
    marketplace: string;
    brand: string;
    rate: unknown;
    plusRate: unknown;
    note: string | null;
    updatedAt: Date;
  },
  category: string,
) {
  const rate = Number(row.rate);
  const plusRate = Number(row.plusRate);
  return {
    id: row.id,
    marketplace: row.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
    marketplaceCode: row.marketplace as "TRENDYOL" | "HEPSIBURADA",
    category,
    rate,
    ratePct: round2(rate * 100),
    plusRate,
    plusRatePct: round2(plusRate * 100),
    note: row.note ?? `Marka ${row.brand}`,
    updatedAt: row.updatedAt.toISOString(),
    isOverride: false as const,
    storeId: null as string | null,
    storeName: null as string | null,
    rateSource: "brand" as const,
  };
}

function mapOverride(row: {
  id: string;
  storeId: string;
  category: string;
  rate: unknown;
  plusRate: unknown;
  note: string | null;
  updatedAt: Date;
  store: { id: string; name: string; marketplace: string };
}) {
  const rate = Number(row.rate);
  const plusRate = Number(row.plusRate);
  return {
    id: row.id,
    marketplace:
      row.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
    marketplaceCode: row.store.marketplace as "TRENDYOL" | "HEPSIBURADA",
    category: row.category,
    rate,
    ratePct: round2(rate * 100),
    plusRate,
    plusRatePct: round2(plusRate * 100),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
    isOverride: true as const,
    storeId: row.storeId,
    storeName: row.store.name,
    rateSource: "override" as const,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

function normalizeMarketplaceCode(
  raw?: string,
): "TRENDYOL" | "HEPSIBURADA" | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "trendyol" || t === "ty") return "TRENDYOL";
  if (t === "hepsiburada" || t === "hb" || t === "hepsi" || t.includes("hepsi")) {
    return "HEPSIBURADA";
  }
  return undefined;
}
