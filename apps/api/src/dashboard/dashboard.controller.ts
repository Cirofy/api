import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";

const ALLOWED_DAYS = new Set([7, 30, 90]);

@ApiTags("dashboard")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("summary")
  async summary(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return emptySummary("Organizasyon yok");
    }

    const days = parseDays(daysRaw);
    const now = Date.now();
    const periodStart = new Date(now - days * 86400_000);
    const prevStart = new Date(now - days * 2 * 86400_000);

    const [agg, stores, recent, daily, current, previous] = await Promise.all([
      this.prisma.order.aggregate({
        where: { organizationId: orgId },
        _sum: { netProfit: true, grossAmount: true },
        _count: true,
      }),
      this.prisma.store.findMany({
        where: { organizationId: orgId },
        select: { id: true, name: true, isConnected: true, marketplace: true },
      }),
      this.prisma.order.findMany({
        where: { organizationId: orgId },
        orderBy: { orderedAt: "desc" },
        take: 8,
        select: {
          externalId: true,
          status: true,
          netProfit: true,
          orderedAt: true,
          items: {
            take: 1,
            select: { product: { select: { title: true } } },
          },
        },
      }),
      this.prisma.order.findMany({
        where: { organizationId: orgId, orderedAt: { gte: periodStart } },
        select: {
          orderedAt: true,
          netProfit: true,
          grossAmount: true,
          status: true,
          items: {
            take: 1,
            select: {
              product: {
                select: { title: true, category: true, brand: true },
              },
            },
          },
        },
        orderBy: { orderedAt: "asc" },
        take: 5000,
      }),
      this.prisma.order.aggregate({
        where: {
          organizationId: orgId,
          orderedAt: { gte: periodStart },
        },
        _sum: { netProfit: true, grossAmount: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: {
          organizationId: orgId,
          orderedAt: { gte: prevStart, lt: periodStart },
        },
        _sum: { netProfit: true, grossAmount: true },
        _count: true,
      }),
    ]);

    const net = Number(agg._sum.netProfit ?? 0);
    const gross = Number(agg._sum.grossAmount ?? 0);
    const marginPct = gross > 0 ? (net / gross) * 100 : 0;

    const curNet = Number(current._sum.netProfit ?? 0);
    const curGross = Number(current._sum.grossAmount ?? 0);
    const curCount = current._count;
    const curMargin = curGross > 0 ? (curNet / curGross) * 100 : 0;

    const prevNet = Number(previous._sum.netProfit ?? 0);
    const prevGross = Number(previous._sum.grossAmount ?? 0);
    const prevCount = previous._count;
    const prevMargin = prevGross > 0 ? (prevNet / prevGross) * 100 : 0;

    const byDay = new Map<
      string,
      { profit: number; sales: number; orders: number }
    >();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, { profit: 0, sales: 0, orders: 0 });
    }
    for (const row of daily) {
      const key = row.orderedAt.toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (!bucket) continue;
      bucket.profit += Number(row.netProfit);
      bucket.sales += Number(row.grossAmount);
      bucket.orders += 1;
    }

    const chartEntries = [...byDay.entries()];
    const chart =
      days <= 7
        ? chartEntries.map(([date, v]) => ({
            day: formatWeekdayLabel(date),
            profit: Math.round(v.profit),
            sales: Math.round(v.sales),
            orders: v.orders,
          }))
        : downsampleChart(chartEntries, days <= 30 ? 10 : 12);

    const categoryBuckets = new Map<
      string,
      { category: string; net: number; gross: number; orderCount: number }
    >();
    const productBuckets = new Map<
      string,
      { name: string; net: number; orderCount: number }
    >();
    const brandBuckets = new Map<
      string,
      { brand: string; net: number; orderCount: number }
    >();
    let profitOrders = 0;
    let lossOrders = 0;
    let returnOrders = 0;

    for (const row of daily) {
      const net = Number(row.netProfit);
      const gross = Number(row.grossAmount);
      const status = String(row.status || "").toUpperCase();
      if (status.includes("RETURN") || status.includes("CANCEL")) {
        returnOrders += 1;
      } else if (net < 0) {
        lossOrders += 1;
      } else {
        profitOrders += 1;
      }

      const product = row.items[0]?.product;
      const cat = product?.category?.trim() || "Diğer";
      const catCur = categoryBuckets.get(cat) ?? {
        category: cat,
        net: 0,
        gross: 0,
        orderCount: 0,
      };
      catCur.net += net;
      catCur.gross += gross;
      catCur.orderCount += 1;
      categoryBuckets.set(cat, catCur);

      const title = product?.title?.trim() || "Ürün";
      const prodCur = productBuckets.get(title) ?? {
        name: title,
        net: 0,
        orderCount: 0,
      };
      prodCur.net += net;
      prodCur.orderCount += 1;
      productBuckets.set(title, prodCur);

      const brand = product?.brand?.trim() || "Diğer";
      const brandCur = brandBuckets.get(brand) ?? {
        brand,
        net: 0,
        orderCount: 0,
      };
      brandCur.net += net;
      brandCur.orderCount += 1;
      brandBuckets.set(brand, brandCur);
    }

    const categoryChart = [...categoryBuckets.values()]
      .map((b) => ({
        category: b.category,
        net: round2(b.net),
        marginPct: b.gross > 0 ? round2((b.net / b.gross) * 100) : 0,
        orderCount: b.orderCount,
      }))
      .sort((a, b) => b.net - a.net)
      .slice(0, 8);

    const topProducts = [...productBuckets.values()]
      .map((b) => ({
        name: b.name,
        net: round2(b.net),
        orderCount: b.orderCount,
      }))
      .sort((a, b) => b.net - a.net)
      .slice(0, 8);

    const brandChart = [...brandBuckets.values()]
      .map((b) => ({
        brand: b.brand,
        net: round2(b.net),
        orderCount: b.orderCount,
      }))
      .sort((a, b) => b.net - a.net)
      .slice(0, 8);

    const productCount = await this.prisma.product.count({
      where: { organizationId: orgId },
    });

    return {
      netProfit: round2(curNet || net),
      marginPct: Number((curGross > 0 ? curMargin : marginPct).toFixed(2)),
      orderCount: curCount || agg._count,
      grossAmount: round2(curGross || gross),
      stores: stores.length,
      connectedStores: stores.filter((s) => s.isConnected).length,
      hasData: agg._count > 0,
      periodDays: days,
      chart,
      categoryChart,
      topProducts,
      brandChart,
      profitMix: {
        profit: profitOrders,
        loss: lossOrders,
        returns: returnOrders,
      },
      recentOrders: recent.map((o) => ({
        id: o.externalId,
        product: o.items[0]?.product?.title ?? "Ürün",
        profit: Number(o.netProfit),
        status: o.status,
        orderedAt: o.orderedAt.toISOString(),
      })),
      delta: {
        netProfit: pctDelta(curNet, prevNet),
        marginPct: round2(curMargin - prevMargin),
        orderCount: pctDelta(curCount, prevCount),
        grossAmount: pctDelta(curGross, prevGross),
      },
      alerts: buildAlerts({
        hasStore: stores.length > 0,
        hasData: agg._count > 0,
        marginPct: curGross > 0 ? curMargin : marginPct,
        productCount,
      }),
    };
  }
}

function parseDays(raw?: string) {
  const n = Number(raw);
  return ALLOWED_DAYS.has(n) ? n : 7;
}

function downsampleChart(
  entries: Array<[string, { profit: number; sales: number; orders: number }]>,
  buckets: number,
) {
  if (entries.length <= buckets) {
    return entries.map(([date, v]) => ({
      day: formatShortDate(date),
      profit: Math.round(v.profit),
      sales: Math.round(v.sales),
      orders: v.orders,
    }));
  }
  const size = Math.ceil(entries.length / buckets);
  const out: Array<{
    day: string;
    profit: number;
    sales: number;
    orders: number;
  }> = [];
  for (let i = 0; i < entries.length; i += size) {
    const slice = entries.slice(i, i + size);
    const profit = slice.reduce((s, [, v]) => s + v.profit, 0);
    const sales = slice.reduce((s, [, v]) => s + v.sales, 0);
    const orders = slice.reduce((s, [, v]) => s + v.orders, 0);
    const midEntry = slice[Math.floor(slice.length / 2)] ?? slice[0];
    if (!midEntry) continue;
    out.push({
      day: formatShortDate(midEntry[0]),
      profit: Math.round(profit),
      sales: Math.round(sales),
      orders,
    });
  }
  return out;
}

function pctDelta(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function emptySummary(note: string) {
  return {
    netProfit: 0,
    marginPct: 0,
    orderCount: 0,
    grossAmount: 0,
    stores: 0,
    connectedStores: 0,
    hasData: false,
    periodDays: 7,
    chart: [],
    categoryChart: [],
    topProducts: [],
    brandChart: [],
    profitMix: { profit: 0, loss: 0, returns: 0 },
    recentOrders: [],
    alerts: [],
    delta: {
      netProfit: 0,
      marginPct: 0,
      orderCount: 0,
      grossAmount: 0,
    },
    note,
  };
}

function formatWeekdayLabel(isoDate: string) {
  const days = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
  const d = new Date(isoDate + "T12:00:00");
  return days[d.getDay()] ?? isoDate.slice(5);
}

function formatShortDate(isoDate: string) {
  const [, m, d] = isoDate.split("-");
  return `${Number(d)}.${Number(m)}`;
}

function buildAlerts(input: {
  hasStore: boolean;
  hasData: boolean;
  marginPct: number;
  productCount: number;
}) {
  const alerts: Array<{ title: string; body: string; tone: "warn" | "loss" | "profit" }> = [];
  if (!input.hasStore) {
    alerts.push({
      title: "Mağaza bağla",
      body: "Net kâr verisi için pazaryeri bağlantısı gerekli.",
      tone: "warn",
    });
  } else if (!input.hasData) {
    alerts.push({
      title: "Veri bekleniyor",
      body: "Bağlantı var ama henüz sipariş senkronu yok. Ayarlar’dan senkron başlatın.",
      tone: "warn",
    });
  }
  if (input.hasData && input.marginPct < 10) {
    alerts.push({
      title: "Düşük marj",
      body: `Ortalama net marj %${input.marginPct.toFixed(1)}. Kampanya ve maliyetleri gözden geçir.`,
      tone: "loss",
    });
  }
  if (input.hasData && input.marginPct >= 15) {
    alerts.push({
      title: "Sağlıklı marj",
      body: "Net marj hedefin üzerinde görünüyor.",
      tone: "profit",
    });
  }
  return alerts;
}
