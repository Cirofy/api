import { BadRequestException, Injectable } from "@nestjs/common";
import { decryptCredential } from "../marketplace/credential-crypto";
import { MarketplaceRegistry } from "../marketplace/marketplace.registry";
import type {
  MarketplaceCode,
  PulledAccountingRow,
  PulledSettlementRow,
} from "../marketplace/marketplace.types";
import { PrismaService } from "../prisma/prisma.service";
import { TariffsService } from "../tariffs/tariffs.service";

export type SettlementIssueType =
  | "extra_shipping"
  | "missing_return_commission"
  | "missing_sale"
  | "desi_mismatch";

export type SettlementPeriodDto = {
  id: string;
  storeId: string;
  storeName: string;
  period: string;
  expected: number;
  paid: number;
  diff: number;
  status: "Ödendi" | "İnceleniyor";
  paidAt: string | null;
};

export type SettlementIssueDto = {
  id: string;
  storeId: string;
  storeName: string;
  type: SettlementIssueType;
  orderId: string;
  period: string;
  expected: number;
  billed: number;
  diff: number;
  note: string;
  status: "open" | "resolved";
  productId?: string | null;
  sku?: string | null;
  tariffMismatch?: boolean;
  tariffDeltaPct?: number | null;
};

export type SettlementStoreOption = {
  id: string;
  name: string;
  marketplace: string;
};

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
    private readonly marketplaces: MarketplaceRegistry,
  ) {}

  async sync(organizationId: string) {
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
        "Önce Ayarlar’dan mağaza bağlayın; hakediş senkronu anahtar ister.",
      );
    }

    const storeMap = new Map(stores.map((s) => [s.id, s.name]));
    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        sku: true,
        barcode: true,
        storeId: true,
        shippingCost: true,
        title: true,
      },
    });
    const productByBarcode = new Map<string, (typeof products)[number]>();
    const productBySku = new Map<string, (typeof products)[number]>();
    for (const p of products) {
      if (p.barcode) productByBarcode.set(p.barcode.trim(), p);
      if (p.sku) productBySku.set(p.sku.trim(), p);
    }

    const periods: SettlementPeriodDto[] = [];
    const issues: Omit<SettlementIssueDto, "status">[] = [];
    const errors: string[] = [];
    const sinceDays = 14;
    const end = new Date();
    const start = new Date(end.getTime() - sinceDays * 86400_000);
    const beginDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

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
      const storeName = store.name;

      try {
        if (store.marketplace === "TRENDYOL" && adapter.pullSettlements) {
          const saleRows = await adapter.pullSettlements(creds, {
            transactionType: "Sale",
            sinceDays,
          });
          const returnRows = await adapter.pullSettlements(creds, {
            transactionType: "Return",
            sinceDays,
          });
          const deliveryRows = await adapter.pullSettlements(creds, {
            transactionType: "DeliveryFee",
            sinceDays,
          });

          const built = buildTrendyolLivePeriods(
            store.id,
            storeName,
            saleRows,
            returnRows,
            deliveryRows,
            productByBarcode,
            productBySku,
          );
          periods.push(...built.periods);
          issues.push(...built.issues);
        }

        if (
          store.marketplace === "HEPSIBURADA" &&
          adapter.pullAccountingTransactions
        ) {
          const txRows = await adapter.pullAccountingTransactions(creds, {
            beginDate,
            endDate,
          });
          const built = buildHepsiburadaLivePeriods(
            store.id,
            storeName,
            txRows,
          );
          periods.push(...built.periods);
          issues.push(...built.issues);
        }
      } catch {
        errors.push(`${store.name}: hakediş çekimi tamamlanamadı`);
      }
    }

    const resolvedKeys = await this.resolvedDedupeKeys(organizationId);
    const issuesWithStatus = issues.map((i) => ({
      ...i,
      status: (resolvedKeys.has(i.id) ? "resolved" : "open") as
        | "open"
        | "resolved",
    }));

    if (periods.length > 0 || issuesWithStatus.length > 0) {
      await this.persist(organizationId, periods, issuesWithStatus);
    }

    const message =
      periods.length > 0
        ? `${periods.length} dönem, ${issuesWithStatus.length} sapma kaydedildi.${
            errors.length ? ` ${errors.join(" · ")}` : ""
          }`
        : errors.length > 0
          ? errors.join(" · ")
          : "Pazaryerinden hakediş satırı alınamadı.";

    return {
      ok: periods.length > 0 || issuesWithStatus.length > 0,
      periods: periods.length,
      issues: issuesWithStatus.length,
      message,
    };
  }

  async overview(organizationId: string, storeId?: string) {
    const stores = await this.prisma.store.findMany({
      where: { organizationId },
      select: { id: true, name: true, marketplace: true },
      orderBy: { createdAt: "asc" },
    });
    const storeOptions: SettlementStoreOption[] = stores.map((s) => ({
      id: s.id,
      name: s.name,
      marketplace:
        s.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
    }));
    const storeMap = new Map(stores.map((s) => [s.id, s.name]));

    const filterStoreId =
      storeId && stores.some((s) => s.id === storeId) ? storeId : undefined;

    const activeStoreName = filterStoreId
      ? storeMap.get(filterStoreId) || "Mağaza"
      : stores.map((s) => s.name).join(" / ") || "Mağaza";

    const livePeriodCount = await this.prisma.settlementPeriod.count({
      where: {
        organizationId,
        ...(filterStoreId ? { storeId: filterStoreId } : {}),
      },
    });

    if (livePeriodCount > 0) {
      const cached = await this.readPersisted(
        organizationId,
        filterStoreId,
        storeMap,
      );
      const resolvedKeys = await this.resolvedDedupeKeys(organizationId);
      const issues = cached.issues.map((i) => ({
        ...i,
        status: (resolvedKeys.has(i.id) ? "resolved" : "open") as
          | "open"
          | "resolved",
      }));
      const [desiGaps, tariffGaps] = await Promise.all([
        this.listDesiGaps(organizationId, filterStoreId),
        this.listTariffGaps(organizationId, filterStoreId),
      ]);
      return {
        periods: cached.periods,
        issues: this.annotateTariffOnIssues(issues, tariffGaps),
        desiGaps,
        tariffGaps,
        stores: storeOptions,
        storeId: filterStoreId ?? null,
        storeName: activeStoreName,
        source: "live" as const,
        note: "Pazaryerinden senkronlanan hakediş özeti.",
      };
    }

    const orders = await this.prisma.order.findMany({
      where: {
        organizationId,
        ...(filterStoreId ? { storeId: filterStoreId } : {}),
      },
      orderBy: { orderedAt: "desc" },
      take: 400,
      select: {
        id: true,
        storeId: true,
        externalId: true,
        status: true,
        orderedAt: true,
        grossAmount: true,
        commission: true,
        shippingFee: true,
        netProfit: true,
        items: {
          take: 1,
          select: {
            product: {
              select: {
                id: true,
                sku: true,
                shippingCost: true,
                title: true,
                desi: true,
              },
            },
          },
        },
      },
    });

    if (orders.length === 0) {
      const cached = await this.readPersisted(organizationId, filterStoreId, storeMap);
      if (cached.periods.length || cached.issues.length) {
        const [desiGaps, tariffGaps] = await Promise.all([
          this.listDesiGaps(organizationId, filterStoreId),
          this.listTariffGaps(organizationId, filterStoreId),
        ]);
        return {
          ...cached,
          issues: this.annotateTariffOnIssues(cached.issues, tariffGaps),
          desiGaps,
          tariffGaps,
          stores: storeOptions,
          storeId: filterStoreId ?? null,
          storeName: activeStoreName,
          source: "persisted" as const,
          note: "Kayıtlı hakediş özeti (yeni sipariş yok).",
        };
      }
      const [desiGaps, tariffGaps] = await Promise.all([
        this.listDesiGaps(organizationId, filterStoreId),
        this.listTariffGaps(organizationId, filterStoreId),
      ]);
      return {
        periods: [] as SettlementPeriodDto[],
        issues: [] as SettlementIssueDto[],
        desiGaps,
        tariffGaps,
        stores: storeOptions,
        storeId: filterStoreId ?? null,
        storeName: activeStoreName,
        source: "empty" as const,
        note: "Henüz sipariş yok — senkron sonrası hakediş oluşur.",
      };
    }

    const resolvedKeys = await this.resolvedDedupeKeys(organizationId);
    const rawIssues = detectIssues(orders, storeMap);
    const issues = rawIssues.map((i) => ({
      ...i,
      status: (resolvedKeys.has(i.id) ? "resolved" : "open") as
        | "open"
        | "resolved",
    }));
    const periods = buildPeriods(orders, issues, storeMap);
    await this.persist(organizationId, periods, issues);
    const [desiGaps, tariffGaps] = await Promise.all([
      this.listDesiGaps(organizationId, filterStoreId),
      this.listTariffGaps(organizationId, filterStoreId),
    ]);

    return {
      periods,
      issues: this.annotateTariffOnIssues(issues, tariffGaps),
      desiGaps,
      tariffGaps,
      stores: storeOptions,
      storeId: filterStoreId ?? null,
      storeName: activeStoreName,
      source: "persisted" as const,
      note: filterStoreId
        ? "Seçili mağaza için siparişlerden hesaplanan hakediş."
        : "Tüm mağazalar — siparişlerden hesaplanıp kaydedilen hakediş.",
    };
  }

  /** Desi tanımsız / sıfır ürünler — kargo tahmini güvenilmez. */
  private async listDesiGaps(organizationId: string, storeId?: string) {
    const products = await this.prisma.product.findMany({
      where: {
        organizationId,
        isActive: true,
        desi: { lte: 0 },
        ...(storeId ? { storeId } : {}),
      },
      select: {
        id: true,
        sku: true,
        title: true,
        desi: true,
        store: { select: { name: true, marketplace: true } },
      },
      take: 40,
      orderBy: { title: "asc" },
    });
    return {
      count: products.length,
      items: products.map((p) => ({
        productId: p.id,
        sku: p.sku,
        title: p.title,
        desi: Number(p.desi),
        storeName: p.store.name,
        marketplace:
          p.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
      })),
      message:
        products.length > 0
          ? `${products.length} üründe desi tanımsız — kargo sapması güvenilmez.`
          : "Aktif ürünlerde desi tanımlı.",
    };
  }

  /** Komisyon tarifesinden sapan ürünler — hakediş komisyon satırı sapabilir. */
  private async listTariffGaps(organizationId: string, storeId?: string) {
    const { items } = await this.tariffs.listMismatches(organizationId, 80);
    let filtered = items;
    if (storeId) {
      const inStore = await this.prisma.product.findMany({
        where: { organizationId, storeId, isActive: true },
        select: { id: true },
      });
      const allow = new Set(inStore.map((p) => p.id));
      filtered = items.filter((i) => allow.has(i.productId));
    }
    const slice = filtered.slice(0, 40);
    return {
      count: filtered.length,
      items: slice.map((i) => ({
        productId: i.productId,
        sku: i.sku,
        title: i.title,
        currentRatePct: i.currentRatePct,
        suggestedRatePct: i.suggestedRatePct,
        deltaPct: i.deltaPct,
        marketplace: i.marketplace,
        category: i.category,
      })),
      message:
        filtered.length > 0
          ? `${filtered.length} üründe komisyon tarifeden sapıyor — hakediş komisyon satırları sapabilir.`
          : "Komisyon tarifesiyle uyumlu — sapma yok.",
    };
  }

  private annotateTariffOnIssues(
    issues: SettlementIssueDto[],
    tariffGaps: Awaited<ReturnType<SettlementsService["listTariffGaps"]>>,
  ): SettlementIssueDto[] {
    const byProductId = new Map(
      tariffGaps.items.map((i) => [i.productId, i] as const),
    );
    const bySku = new Map(
      tariffGaps.items
        .filter((i) => i.sku)
        .map((i) => [i.sku as string, i] as const),
    );
    return issues.map((issue) => {
      const hit =
        (issue.productId ? byProductId.get(issue.productId) : undefined) ??
        (issue.sku ? bySku.get(issue.sku) : undefined);
      if (!hit) {
        return {
          ...issue,
          tariffMismatch: false,
          tariffDeltaPct: null,
        };
      }
      return {
        ...issue,
        tariffMismatch: true,
        tariffDeltaPct: hit.deltaPct,
      };
    });
  }

  async updateIssueStatus(
    organizationId: string,
    dedupeKey: string,
    status: "open" | "resolved",
  ) {
    const existing = await this.prisma.settlementIssue.findUnique({
      where: {
        organizationId_dedupeKey: { organizationId, dedupeKey },
      },
    });
    if (!existing) {
      return { ok: false as const, message: "Sapma kaydı bulunamadı." };
    }
    const row = await this.prisma.settlementIssue.update({
      where: { id: existing.id },
      data: {
        status,
        resolvedAt: status === "resolved" ? new Date() : null,
      },
    });
    const store = await this.prisma.store.findFirst({
      where: { id: row.storeId, organizationId },
      select: { name: true },
    });
    return {
      ok: true as const,
      item: {
        id: row.dedupeKey,
        storeId: row.storeId,
        storeName: store?.name ?? "Mağaza",
        type: row.type as SettlementIssueType,
        orderId: row.orderExternalId,
        period: row.periodLabel,
        expected: Number(row.expected),
        billed: Number(row.billed),
        diff: Number(row.diff),
        note: row.note,
        status: row.status === "resolved" ? ("resolved" as const) : ("open" as const),
      },
      message: status === "resolved" ? "Sapma kapatıldı." : "Sapma yeniden açıldı.",
    };
  }

  private async resolvedDedupeKeys(organizationId: string) {
    const rows = await this.prisma.settlementIssue.findMany({
      where: { organizationId, status: "resolved" },
      select: { dedupeKey: true },
    });
    return new Set(rows.map((r) => r.dedupeKey));
  }

  private async readPersisted(
    organizationId: string,
    storeId: string | undefined,
    storeMap: Map<string, string>,
  ) {
    const where = {
      organizationId,
      ...(storeId ? { storeId } : {}),
    };
    const [periodRows, issueRows] = await Promise.all([
      this.prisma.settlementPeriod.findMany({
        where,
        orderBy: { periodKey: "desc" },
        take: 24,
      }),
      this.prisma.settlementIssue.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 40,
      }),
    ]);

    return {
      periods: periodRows.map(
        (p): SettlementPeriodDto => ({
          id: `${p.storeId}:${p.periodKey}`,
          storeId: p.storeId,
          storeName: storeMap.get(p.storeId) || "Mağaza",
          period: p.periodLabel,
          expected: Number(p.expected),
          paid: Number(p.paid),
          diff: Number(p.diff),
          status: p.status === "İnceleniyor" ? "İnceleniyor" : "Ödendi",
          paidAt: p.paidAt ? p.paidAt.toISOString().slice(0, 10) : null,
        }),
      ),
      issues: issueRows.map(
        (i): SettlementIssueDto => ({
          id: i.dedupeKey,
          storeId: i.storeId,
          storeName: storeMap.get(i.storeId) || "Mağaza",
          type: i.type as SettlementIssueType,
          orderId: i.orderExternalId,
          period: i.periodLabel,
          expected: Number(i.expected),
          billed: Number(i.billed),
          diff: Number(i.diff),
          note: i.note,
          status: i.status === "resolved" ? "resolved" : "open",
        }),
      ),
    };
  }

  private async persist(
    organizationId: string,
    periods: SettlementPeriodDto[],
    issues: SettlementIssueDto[],
  ) {
    const now = new Date();
    const periodIdByComposite = new Map<string, string>();

    for (const p of periods) {
      const periodKey = p.id.includes(":") ? p.id.split(":").slice(1).join(":") : p.id;
      const row = await this.prisma.settlementPeriod.upsert({
        where: {
          organizationId_storeId_periodKey: {
            organizationId,
            storeId: p.storeId,
            periodKey,
          },
        },
        create: {
          organizationId,
          storeId: p.storeId,
          periodKey,
          periodLabel: p.period,
          expected: p.expected,
          paid: p.paid,
          diff: p.diff,
          status: p.status,
          paidAt: p.paidAt ? new Date(p.paidAt) : null,
          computedAt: now,
        },
        update: {
          periodLabel: p.period,
          expected: p.expected,
          paid: p.paid,
          diff: p.diff,
          status: p.status,
          paidAt: p.paidAt ? new Date(p.paidAt) : null,
          computedAt: now,
        },
      });
      periodIdByComposite.set(p.id, row.id);
    }

    for (const issue of issues) {
      const periodId =
        periodIdByComposite.get(
          periods.find(
            (p) => p.storeId === issue.storeId && p.period === issue.period,
          )?.id ?? "",
        ) ?? null;
      await this.prisma.settlementIssue.upsert({
        where: {
          organizationId_dedupeKey: {
            organizationId,
            dedupeKey: issue.id,
          },
        },
        create: {
          organizationId,
          storeId: issue.storeId,
          periodId,
          dedupeKey: issue.id,
          type: issue.type,
          orderExternalId: issue.orderId,
          periodLabel: issue.period,
          expected: issue.expected,
          billed: issue.billed,
          diff: issue.diff,
          note: issue.note,
          status: issue.status,
        },
        update: {
          storeId: issue.storeId,
          periodId,
          type: issue.type,
          orderExternalId: issue.orderId,
          periodLabel: issue.period,
          expected: issue.expected,
          billed: issue.billed,
          diff: issue.diff,
          note: issue.note,
          status: issue.status,
        },
      });
    }
  }
}

type OrderRow = {
  id: string;
  storeId: string;
  externalId: string;
  status: string;
  orderedAt: Date;
  grossAmount: unknown;
  commission: unknown;
  shippingFee: unknown;
  netProfit: unknown;
  items: Array<{
    product: {
      id: string;
      sku: string | null;
      shippingCost: unknown;
      title: string;
      desi: unknown;
    } | null;
  }>;
};

function detectIssues(
  orders: OrderRow[],
  storeMap: Map<string, string>,
): Omit<SettlementIssueDto, "status">[] {
  const issues: Omit<SettlementIssueDto, "status">[] = [];

  for (const o of orders) {
    const period = weekLabel(o.orderedAt);
    const ship = Number(o.shippingFee);
    const product = o.items[0]?.product;
    const productId = product?.id ?? null;
    const sku = product?.sku ?? null;
    const expectedShip = Number(product?.shippingCost ?? 35);
    const productDesi = product?.desi != null ? Number(product.desi) : 0;
    const commission = Number(o.commission);
    const gross = Number(o.grossAmount);
    const storeName = storeMap.get(o.storeId) || "Mağaza";
    const productMeta = { productId, sku };

    if (ship > expectedShip * 1.35 + 1) {
      const ratio = expectedShip > 0 ? ship / expectedShip : 1;
      const inferredDesi =
        productDesi > 0 ? round2(productDesi * ratio) : null;
      const desiNote =
        productDesi <= 0
          ? " · ürün desi tanımsız"
          : inferredDesi != null && inferredDesi > productDesi + 0.4
            ? ` · desi ${productDesi} → tahmini fatura ~${inferredDesi}`
            : productDesi > 0
              ? ` · kayıtlı desi ${productDesi}`
              : "";
      issues.push({
        id: `ship-${o.id}`,
        storeId: o.storeId,
        storeName,
        type: "extra_shipping",
        orderId: o.externalId,
        period,
        expected: round2(expectedShip),
        billed: round2(ship),
        diff: round2(expectedShip - ship),
        note: `Beklenen kargo ₺${round2(expectedShip)} · kesilen ₺${round2(ship)}${desiNote}`,
        ...productMeta,
      });

      if (
        productDesi > 0 &&
        inferredDesi != null &&
        inferredDesi > productDesi + 0.5
      ) {
        issues.push({
          id: `desi-${o.id}`,
          storeId: o.storeId,
          storeName,
          type: "desi_mismatch",
          orderId: o.externalId,
          period,
          expected: productDesi,
          billed: inferredDesi,
          diff: round2(productDesi - inferredDesi),
          note: `${product?.title ?? "Ürün"}: kayıtlı ${productDesi} desi, faturadan ~${inferredDesi} desi`,
          ...productMeta,
        });
      }
    } else if (productDesi <= 0 && ship > 0 && product) {
      issues.push({
        id: `desi-miss-${o.id}`,
        storeId: o.storeId,
        storeName,
        type: "desi_mismatch",
        orderId: o.externalId,
        period,
        expected: 0,
        billed: round2(ship),
        diff: 0,
        note: `${product.title}: desi tanımsız — kargo ₺${round2(ship)} doğrulanamaz`,
        ...productMeta,
      });
    }

    if (o.status === "RETURNED" && commission > 0) {
      issues.push({
        id: `ret-${o.id}`,
        storeId: o.storeId,
        storeName,
        type: "missing_return_commission",
        orderId: o.externalId,
        period,
        expected: round2(commission),
        billed: 0,
        diff: round2(-commission),
        note: "İade komisyon iadesi hakedişte görünmüyor",
        ...productMeta,
      });
    }

  }

  return issues.slice(0, 60);
}

function buildPeriods(
  orders: OrderRow[],
  issues: Array<{
    storeId: string;
    period: string;
    diff: number;
    status?: string;
  }>,
  storeMap: Map<string, string>,
): SettlementPeriodDto[] {
  const buckets = new Map<
    string,
    {
      storeId: string;
      label: string;
      start: Date;
      expected: number;
      issueDiff: number;
    }
  >();

  for (const o of orders) {
    const { key, label, start } = weekMeta(o.orderedAt);
    const composite = `${o.storeId}:${key}`;
    const cur = buckets.get(composite) ?? {
      storeId: o.storeId,
      label,
      start,
      expected: 0,
      issueDiff: 0,
    };
    cur.expected += Number(o.netProfit);
    buckets.set(composite, cur);
  }

  for (const issue of issues) {
    if (issue.status === "resolved") continue;
    const meta = weekMetaFromLabel(issue.period, orders);
    if (!meta) continue;
    const composite = `${issue.storeId}:${meta.key}`;
    const cur = buckets.get(composite);
    if (!cur) continue;
    cur.issueDiff += issue.diff;
  }

  const sorted = [...buckets.entries()].sort(
    (a, b) => b[1].start.getTime() - a[1].start.getTime(),
  );

  return sorted.slice(0, 24).map(([composite, b], idx) => {
    const expected = round2(b.expected);
    const paid = round2(expected + b.issueDiff);
    const diff = round2(paid - expected);
    const open = diff < -1 || idx === 0;
    const paidAt = open
      ? null
      : new Date(b.start.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
    return {
      id: composite,
      storeId: b.storeId,
      storeName: storeMap.get(b.storeId) || "Mağaza",
      period: b.label,
      expected,
      paid,
      diff,
      status: open && diff < 0 ? ("İnceleniyor" as const) : ("Ödendi" as const),
      paidAt,
    };
  });
}

function weekMeta(d: Date) {
  const start = startOfWeek(d);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const key = start.toISOString().slice(0, 10);
  return { key, label: formatPeriod(start, end), start };
}

function weekLabel(d: Date) {
  return weekMeta(d).label;
}

function weekMetaFromLabel(label: string, orders: OrderRow[]) {
  for (const o of orders) {
    const m = weekMeta(o.orderedAt);
    if (m.label === label) return m;
  }
  return null;
}

function startOfWeek(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  return x;
}

function formatPeriod(start: Date, end: Date) {
  const months = [
    "Oca",
    "Şub",
    "Mar",
    "Nis",
    "May",
    "Haz",
    "Tem",
    "Ağu",
    "Eyl",
    "Eki",
    "Kas",
    "Ara",
  ];
  const sD = start.getUTCDate();
  const eD = end.getUTCDate();
  const sM = months[start.getUTCMonth()]!;
  const eM = months[end.getUTCMonth()]!;
  const year = end.getUTCFullYear();
  if (sM === eM) return `${sD}–${eD} ${sM} ${year}`;
  return `${sD} ${sM} – ${eD} ${eM} ${year}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function parseTxDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function saleAmount(row: PulledSettlementRow) {
  const rev = row.sellerRevenue;
  if (rev != null && rev !== 0) return rev;
  if (row.credit != null && row.credit !== 0) return row.credit;
  if (row.debt != null && row.debt !== 0) return -row.debt;
  return 0;
}

function buildTrendyolLivePeriods(
  storeId: string,
  storeName: string,
  saleRows: PulledSettlementRow[],
  returnRows: PulledSettlementRow[],
  deliveryRows: PulledSettlementRow[],
  productByBarcode: Map<
    string,
    {
      id: string;
      sku: string | null;
      barcode: string | null;
      shippingCost: unknown;
      title: string;
    }
  >,
  productBySku: Map<
    string,
    {
      id: string;
      sku: string | null;
      barcode: string | null;
      shippingCost: unknown;
      title: string;
    }
  >,
) {
  const buckets = new Map<
    string,
    {
      label: string;
      start: Date;
      expected: number;
      paid: number;
      hasPayment: boolean;
    }
  >();

  for (const row of saleRows) {
    const d = parseTxDate(row.transactionDate) ?? new Date();
    const { key, label, start } = weekMeta(d);
    const composite = `${storeId}:${key}`;
    const cur = buckets.get(composite) ?? {
      label,
      start,
      expected: 0,
      paid: 0,
      hasPayment: false,
    };
    cur.expected += saleAmount(row);
    if (row.paymentOrderId) {
      cur.paid += saleAmount(row);
      cur.hasPayment = true;
    }
    buckets.set(composite, cur);
  }

  for (const b of buckets.values()) {
    if (!b.hasPayment) {
      b.paid = b.expected;
    }
  }

  const periods: SettlementPeriodDto[] = [...buckets.entries()]
    .sort((a, b) => b[1].start.getTime() - a[1].start.getTime())
    .map(([composite, b]) => {
      const expected = round2(b.expected);
      const paid = round2(b.paid);
      const diff = round2(paid - expected);
      const open = diff < -1;
      return {
        id: composite,
        storeId,
        storeName,
        period: b.label,
        expected,
        paid,
        diff,
        status: open ? ("İnceleniyor" as const) : ("Ödendi" as const),
        paidAt: open
          ? null
          : new Date(b.start.getTime() + 7 * 86400_000)
              .toISOString()
              .slice(0, 10),
      };
    });

  const issues: Omit<SettlementIssueDto, "status">[] = [];

  for (const row of returnRows) {
    const commission = row.commissionAmount;
    if (commission == null || commission <= 0) continue;
    const d = parseTxDate(row.transactionDate) ?? new Date();
    const period = weekLabel(d);
    const orderId = row.orderId ?? "—";
    const product =
      (row.barcode && productByBarcode.get(row.barcode)) ||
      (row.barcode && productBySku.get(row.barcode)) ||
      null;
    issues.push({
      id: `live-ret-${storeId}-${orderId}-${period}`,
      storeId,
      storeName,
      type: "missing_return_commission",
      orderId,
      period,
      expected: round2(commission),
      billed: 0,
      diff: round2(-commission),
      note: `İade hakedişinde komisyon ₺${round2(commission)}`,
      productId: product?.id ?? null,
      sku: product?.sku ?? row.barcode,
    });
  }

  for (const row of deliveryRows) {
    const billed = Math.abs(
      row.debt ?? row.credit ?? row.sellerRevenue ?? 0,
    );
    if (billed <= 0) continue;
    const d = parseTxDate(row.transactionDate) ?? new Date();
    const period = weekLabel(d);
    const orderId = row.orderId ?? "—";
    const product =
      (row.barcode && productByBarcode.get(row.barcode)) ||
      (row.barcode && productBySku.get(row.barcode)) ||
      null;
    const expectedShip = Number(product?.shippingCost ?? 0);
    // Yalnızca beklenen kargoyu aşan veya ürün maliyeti tanımsız kesintileri sapma say
    if (expectedShip > 0 && billed <= expectedShip * 1.35 + 1) continue;
    issues.push({
      id: `live-ship-${storeId}-${orderId}-${period}`,
      storeId,
      storeName,
      type: "extra_shipping",
      orderId,
      period,
      expected: round2(expectedShip),
      billed: round2(billed),
      diff: round2(expectedShip - billed),
      note:
        expectedShip > 0
          ? `Beklenen kargo ₺${round2(expectedShip)} · kesilen ₺${round2(billed)}${product ? ` · ${product.title}` : ""}`
          : `Kargo kesintisi ₺${round2(billed)}${product ? ` · ${product.title}` : ""}`,
      productId: product?.id ?? null,
      sku: product?.sku ?? row.barcode,
    });
  }

  return { periods, issues };
}

function buildHepsiburadaLivePeriods(
  storeId: string,
  storeName: string,
  rows: PulledAccountingRow[],
) {
  const buckets = new Map<
    string,
    {
      label: string;
      start: Date;
      expected: number;
      paid: number;
      hasPayment: boolean;
    }
  >();
  const issues: Omit<SettlementIssueDto, "status">[] = [];

  for (const row of rows) {
    const typeLower = row.typeName.toLowerCase();
    const d = parseTxDate(row.transactionDate) ?? new Date();
    const { key, label, start } = weekMeta(d);
    const composite = `${storeId}:${key}`;
    const isPayment =
      typeLower.includes("ödeme") ||
      typeLower.includes("payment") ||
      typeLower.includes("havale");
    const isSale =
      typeLower.includes("satış") ||
      typeLower.includes("sale") ||
      typeLower.includes("hakediş") ||
      typeLower.includes("credit");
    const isReturn =
      typeLower.includes("iade") || typeLower.includes("return");
    const isShipping =
      typeLower.includes("kargo") ||
      typeLower.includes("cargo") ||
      typeLower.includes("shipping");

    if (isSale && !isReturn) {
      const cur = buckets.get(composite) ?? {
        label,
        start,
        expected: 0,
        paid: 0,
        hasPayment: false,
      };
      cur.expected += Math.abs(row.amount);
      buckets.set(composite, cur);
    }

    if (isPayment) {
      const cur = buckets.get(composite) ?? {
        label,
        start,
        expected: 0,
        paid: 0,
        hasPayment: false,
      };
      cur.paid += Math.abs(row.amount);
      cur.hasPayment = true;
      buckets.set(composite, cur);
    }

    const isReturnCommission =
      isReturn &&
      (typeLower.includes("komisyon") || typeLower.includes("commission"));
    if (isReturnCommission && row.amount !== 0) {
      const orderId = row.orderId ?? "—";
      const commission = Math.abs(row.amount);
      issues.push({
        id: `live-hb-ret-${storeId}-${orderId}-${key}`,
        storeId,
        storeName,
        type: "missing_return_commission",
        orderId,
        period: label,
        expected: round2(commission),
        billed: 0,
        diff: round2(-commission),
        note: row.description || "İade komisyon satırı",
        productId: null,
        sku: null,
      });
    }

    if (isShipping && row.amount !== 0) {
      const orderId = row.orderId ?? "—";
      issues.push({
        id: `live-hb-ship-${storeId}-${orderId}-${key}`,
        storeId,
        storeName,
        type: "extra_shipping",
        orderId,
        period: label,
        expected: 0,
        billed: round2(Math.abs(row.amount)),
        diff: round2(-Math.abs(row.amount)),
        note: row.description || "Kargo kesintisi",
        productId: null,
        sku: null,
      });
    }
  }

  for (const b of buckets.values()) {
    if (!b.hasPayment) {
      b.paid = b.expected;
    }
  }

  const periods: SettlementPeriodDto[] = [...buckets.entries()]
    .sort((a, b) => b[1].start.getTime() - a[1].start.getTime())
    .map(([composite, b]) => {
      const expected = round2(b.expected);
      const paid = round2(b.paid);
      const diff = round2(paid - expected);
      const open = diff < -1;
      return {
        id: composite,
        storeId,
        storeName,
        period: b.label,
        expected,
        paid,
        diff,
        status: open ? ("İnceleniyor" as const) : ("Ödendi" as const),
        paidAt: open
          ? null
          : new Date(b.start.getTime() + 7 * 86400_000)
              .toISOString()
              .slice(0, 10),
      };
    });

  return { periods, issues };
}
