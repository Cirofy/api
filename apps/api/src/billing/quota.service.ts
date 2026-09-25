import {
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TariffsService } from "../tariffs/tariffs.service";
import { PLAN_QUOTAS, type PlanKey } from "./plan-quotas";

export type { PlanKey } from "./plan-quotas";
export { PLAN_QUOTAS } from "./plan-quotas";

export type UsageSnapshot = {
  planId: PlanKey;
  planLabel: string;
  status: string;
  trialEndsAt: string | null;
  ordersThisMonth: number;
  orderLimit: number;
  orderUsagePct: number;
  storeCount: number;
  storeLimit: number;
  canConnectStore: boolean;
  canSync: boolean;
  blockedReason: string | null;
  nearOrderLimit: boolean;
  nearStoreLimit: boolean;
  nearTariffScanLimit: boolean;
  warnReason: string | null;
  daysLeftInPeriod: number;
  tariffMismatchCount: number;
  tariffScanUsed: number;
  tariffScanLimit: number;
  tariffScanUsagePct: number;
  canScanTariffs: boolean;
  tariffNote: string | null;
};

@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  async getUsage(organizationId: string): Promise<UsageSnapshot> {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });
    const planId = (sub?.planId ?? "STARTER") as PlanKey;
    const quotas = PLAN_QUOTAS[planId] ?? PLAN_QUOTAS.STARTER;

    const start = startOfMonth();
    const [ordersThisMonth, storeCount, productCount, mismatches] =
      await Promise.all([
        this.prisma.order.count({
          where: { organizationId, orderedAt: { gte: start } },
        }),
        this.prisma.store.count({ where: { organizationId } }),
        this.prisma.product.count({
          where: { organizationId, isActive: true },
        }),
        this.tariffs
          .listMismatches(organizationId, quotas.tariffScanLimit)
          .catch(() => ({
            items: [] as Array<unknown>,
            total: 0,
            scanned: 0,
            scanCap: quotas.tariffScanLimit,
            scanCapped: false,
          })),
      ]);

    const tariffMismatchCount =
      typeof mismatches.total === "number"
        ? mismatches.total
        : mismatches.items?.length ?? 0;
    const tariffScanUsed = Math.min(productCount, quotas.tariffScanLimit);
    const tariffScanUsagePct =
      quotas.tariffScanLimit > 0
        ? Math.min(
            100,
            Math.round((productCount / quotas.tariffScanLimit) * 100),
          )
        : 0;
    const overTariffScan = productCount > quotas.tariffScanLimit;
    const nearTariffScanLimit =
      !overTariffScan &&
      quotas.tariffScanLimit > 0 &&
      tariffScanUsagePct >= 80;

    const tariffNote =
      tariffMismatchCount > 0
        ? `${tariffMismatchCount} üründe tarife sapması · tarama kotası ${tariffScanUsed}/${quotas.tariffScanLimit}${
            overTariffScan ? " (limit aşıldı — üst plan önerilir)" : ""
          }.`
        : overTariffScan
          ? `Aktif ürün sayısı tarife tarama limitini aşıyor (${productCount}/${quotas.tariffScanLimit}).`
          : null;

    const orderUsagePct =
      quotas.monthlyOrders > 0
        ? Math.round((ordersThisMonth / quotas.monthlyOrders) * 100)
        : 0;

    const overOrders = ordersThisMonth >= quotas.monthlyOrders;
    const overStores = storeCount >= quotas.maxStores;
    const nearOrderLimit =
      !overOrders && quotas.monthlyOrders > 0 && orderUsagePct >= 80;
    const nearStoreLimit =
      !overStores &&
      quotas.maxStores < 999 &&
      storeCount / Math.max(quotas.maxStores, 1) >= 0.8;

    let blockedReason: string | null = null;
    if (overOrders) {
      blockedReason =
        "Aylık sipariş kotası doldu. Planı yükseltin veya sonraki dönemi bekleyin.";
    } else if (overStores) {
      blockedReason =
        "Mağaza kotası doldu. Planı yükselterek yeni mağaza ekleyebilirsiniz.";
    }

    let warnReason: string | null = null;
    if (!blockedReason) {
      if (nearOrderLimit && nearStoreLimit) {
        warnReason =
          "Sipariş ve mağaza kotanızın %80’ine yaklaştınız. Plan yükseltmeyi düşünün.";
      } else if (nearOrderLimit) {
        warnReason = `Sipariş kotasının %${Math.min(orderUsagePct, 99)}’i doldu. Dönem bitmeden yükseltebilirsiniz.`;
      } else if (nearStoreLimit) {
        warnReason =
          "Mağaza kotasına yaklaşıyorsunuz. Yeni mağaza için üst plan gerekebilir.";
      } else if (nearTariffScanLimit || overTariffScan) {
        warnReason = overTariffScan
          ? "Tarife tarama limiti aşıldı — sapma listesi kısmi olabilir."
          : "Tarife tarama kotasına yaklaşıyorsunuz.";
      }
    }

    return {
      planId,
      planLabel: quotas.label,
      status: sub?.status ?? "TRIALING",
      trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
      ordersThisMonth,
      orderLimit: quotas.monthlyOrders,
      orderUsagePct: Math.min(orderUsagePct, 100),
      storeCount,
      storeLimit: quotas.maxStores,
      canConnectStore: !overStores,
      canSync: !overOrders,
      blockedReason,
      nearOrderLimit,
      nearStoreLimit,
      nearTariffScanLimit: nearTariffScanLimit || overTariffScan,
      warnReason,
      daysLeftInPeriod: daysLeftInBillingPeriod(),
      tariffMismatchCount,
      tariffScanUsed,
      tariffScanLimit: quotas.tariffScanLimit,
      tariffScanUsagePct,
      canScanTariffs: !overTariffScan,
      tariffNote,
    };
  }

  async tariffScanCap(organizationId: string): Promise<number> {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
      select: { planId: true },
    });
    const planId = (sub?.planId ?? "STARTER") as PlanKey;
    return (PLAN_QUOTAS[planId] ?? PLAN_QUOTAS.STARTER).tariffScanLimit;
  }

  async assertCanConnectStore(organizationId: string) {
    const usage = await this.getUsage(organizationId);
    if (!usage.canConnectStore) {
      throw new ForbiddenException(
        usage.blockedReason ?? "Mağaza kotası dolu. Planı yükseltin.",
      );
    }
    return usage;
  }

  async assertCanSync(organizationId: string) {
    const usage = await this.getUsage(organizationId);
    if (!usage.canSync) {
      throw new ForbiddenException(
        usage.blockedReason ??
          "Aylık sipariş kotası doldu. Senkron durduruldu.",
      );
    }
    return usage;
  }
}

function startOfMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function daysLeftInBillingPeriod() {
  const now = new Date();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const ms = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86400_000));
}
