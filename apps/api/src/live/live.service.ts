import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TariffsService } from "../tariffs/tariffs.service";

export type IntradayHour = { hour: string; profit: number; orders: number };

export type LiveChannel = "all" | "Trendyol" | "Hepsiburada";

export type IntradaySnapshot = {
  asOf: string;
  netProfitToday: number;
  orderCountToday: number;
  marginPctToday: number;
  grossAmountToday: number;
  vsYesterdayPct: number;
  hours: IntradayHour[];
  channel: LiveChannel;
  byChannel: Array<{
    marketplace: LiveChannel;
    netProfit: number;
    orderCount: number;
    marginPct: number;
  }>;
  tariffMismatchCount: number;
  source: "stream" | "snapshot" | "orders" | "empty";
  note?: string;
};

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  snapshot(orgId: string, channel: LiveChannel = "all"): Promise<IntradaySnapshot> {
    return this.build(orgId, "snapshot", channel);
  }

  tick(orgId: string, channel: LiveChannel = "all"): Promise<IntradaySnapshot> {
    return this.build(orgId, "stream", channel);
  }

  /** Kanal pay özeti — filtre bağımsız, her iki kanal. */
  async share(orgId: string) {
    const snap = await this.build(orgId, "snapshot", "all");
    const rows = (snap.byChannel ?? []).filter(
      (c) => c.marketplace === "Trendyol" || c.marketplace === "Hepsiburada",
    );
    const absSum = rows.reduce((s, c) => s + Math.abs(c.netProfit), 0);
    const channels = rows.map((c) => {
      const sharePct =
        absSum > 0
          ? Math.round((Math.abs(c.netProfit) / absSum) * 1000) / 10
          : 0;
      return {
        marketplace: c.marketplace as "Trendyol" | "Hepsiburada",
        netProfit: c.netProfit,
        orderCount: c.orderCount,
        marginPct: c.marginPct,
        sharePct,
      };
    });
    return {
      asOf: snap.asOf,
      channels,
      source: snap.source,
      note: snap.note ?? "Kanal payı",
      signedLoss: snap.netProfitToday < 0,
    };
  }

  private async build(
    orgId: string,
    mode: "stream" | "snapshot",
    channel: LiveChannel,
  ): Promise<IntradaySnapshot> {
    const tariffMismatchCount = await this.tariffCount(orgId);

    if (!orgId || orgId === "anon") {
      return {
        ...this.emptyIntraday(channel, "Bugünkü veri için oturum gerekli"),
        tariffMismatchCount: 0,
        source: "empty",
      };
    }

    const fromOrders = await this.fromOrders(orgId, channel);
    if (fromOrders) {
      return {
        ...fromOrders,
        tariffMismatchCount,
        source: mode === "stream" ? "stream" : "orders",
        note:
          channel === "all"
            ? "Bugünkü siparişlerden hesaplandı"
            : `Bugünkü siparişler · ${channel}`,
      };
    }

    return {
      ...this.emptyIntraday(channel, "Bugün henüz sipariş yok"),
      tariffMismatchCount,
      source: "empty",
    };
  }

  private emptyIntraday(
    channel: LiveChannel,
    note: string,
  ): Omit<IntradaySnapshot, "source" | "tariffMismatchCount"> {
    return {
      asOf: new Date().toISOString(),
      netProfitToday: 0,
      orderCountToday: 0,
      marginPctToday: 0,
      grossAmountToday: 0,
      vsYesterdayPct: 0,
      hours: emptyHours(),
      channel,
      byChannel: summarizeByChannel([]),
      note,
    };
  }

  private async tariffCount(orgId: string): Promise<number> {
    if (!orgId || orgId === "anon") return 0;
    try {
      const res = await this.tariffs.listMismatches(orgId, 50);
      return res.total ?? res.items?.length ?? 0;
    } catch {
      return 0;
    }
  }

  private async fromOrders(
    orgId: string,
    channel: LiveChannel,
  ): Promise<Omit<IntradaySnapshot, "source" | "tariffMismatchCount"> | null> {
    const start = startOfUtcDay(new Date());
    const yesterdayStart = new Date(start.getTime() - 86400_000);

    const marketplaceFilter =
      channel === "Trendyol"
        ? ("TRENDYOL" as const)
        : channel === "Hepsiburada"
          ? ("HEPSIBURADA" as const)
          : undefined;

    const [todayOrders, yesterdayAgg, allToday] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          organizationId: orgId,
          orderedAt: { gte: start },
          ...(marketplaceFilter
            ? { store: { marketplace: marketplaceFilter } }
            : {}),
        },
        select: {
          orderedAt: true,
          netProfit: true,
          grossAmount: true,
          store: { select: { marketplace: true } },
        },
      }),
      this.prisma.order.aggregate({
        where: {
          organizationId: orgId,
          orderedAt: { gte: yesterdayStart, lt: start },
          ...(marketplaceFilter
            ? { store: { marketplace: marketplaceFilter } }
            : {}),
        },
        _sum: { netProfit: true },
      }),
      this.prisma.order.findMany({
        where: { organizationId: orgId, orderedAt: { gte: start } },
        select: {
          netProfit: true,
          grossAmount: true,
          store: { select: { marketplace: true } },
        },
      }),
    ]);

    if (todayOrders.length === 0 && allToday.length === 0) return null;
    if (todayOrders.length === 0) {
      return {
        asOf: new Date().toISOString(),
        netProfitToday: 0,
        orderCountToday: 0,
        marginPctToday: 0,
        grossAmountToday: 0,
        vsYesterdayPct: 0,
        hours: emptyHours(),
        channel,
        byChannel: summarizeByChannel(allToday),
        note:
          channel === "all"
            ? "Bugün henüz sipariş yok"
            : `Seçili kanalda bugün sipariş yok · ${channel}`,
      };
    }

    const byHour = new Map<string, { profit: number; orders: number; gross: number }>();
    for (let h = 9; h <= 20; h++) {
      byHour.set(String(h).padStart(2, "0"), { profit: 0, orders: 0, gross: 0 });
    }

    for (const o of todayOrders) {
      const hour = String(o.orderedAt.getUTCHours()).padStart(2, "0");
      const bucket = byHour.get(hour) ?? { profit: 0, orders: 0, gross: 0 };
      bucket.profit += Number(o.netProfit);
      bucket.gross += Number(o.grossAmount);
      bucket.orders += 1;
      byHour.set(hour, bucket);
    }

    const hours: IntradayHour[] = [...byHour.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, v]) => ({
        hour,
        profit: Math.round(v.profit),
        orders: v.orders,
      }));

    const netProfitToday = hours.reduce((s, h) => s + h.profit, 0);
    const orderCountToday = hours.reduce((s, h) => s + h.orders, 0);
    const grossAmountToday = [...byHour.values()].reduce((s, v) => s + v.gross, 0);
    const marginPctToday =
      grossAmountToday > 0 ? (netProfitToday / grossAmountToday) * 100 : 0;
    const yNet = Number(yesterdayAgg._sum.netProfit ?? 0);
    const vsYesterdayPct =
      yNet === 0
        ? netProfitToday === 0
          ? 0
          : 100
        : ((netProfitToday - yNet) / Math.abs(yNet)) * 100;

    return {
      asOf: new Date().toISOString(),
      netProfitToday: Math.round(netProfitToday),
      orderCountToday,
      marginPctToday: Math.round(marginPctToday * 10) / 10,
      grossAmountToday: Math.round(grossAmountToday),
      vsYesterdayPct: Math.round(vsYesterdayPct * 10) / 10,
      hours,
      channel,
      byChannel: summarizeByChannel(allToday),
    };
  }
}

function emptyHours(): IntradayHour[] {
  const hours: IntradayHour[] = [];
  for (let h = 9; h <= 20; h++) {
    hours.push({ hour: String(h).padStart(2, "0"), profit: 0, orders: 0 });
  }
  return hours;
}

function summarizeByChannel(
  orders: Array<{
    netProfit: unknown;
    grossAmount: unknown;
    store: { marketplace: string };
  }>,
) {
  const buckets = new Map<
    string,
    { net: number; gross: number; count: number }
  >();
  for (const o of orders) {
    const key =
      o.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol";
    const cur = buckets.get(key) ?? { net: 0, gross: 0, count: 0 };
    cur.net += Number(o.netProfit);
    cur.gross += Number(o.grossAmount);
    cur.count += 1;
    buckets.set(key, cur);
  }
  return (["Trendyol", "Hepsiburada"] as const).map((marketplace) => {
    const b = buckets.get(marketplace) ?? { net: 0, gross: 0, count: 0 };
    return {
      marketplace: marketplace as "Trendyol" | "Hepsiburada",
      netProfit: Math.round(b.net),
      orderCount: b.count,
      marginPct: b.gross > 0 ? Math.round((b.net / b.gross) * 1000) / 10 : 0,
    };
  });
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
