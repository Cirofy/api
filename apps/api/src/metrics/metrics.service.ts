import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private lastRunDay: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Saatlik kontrol: gün değiştiyse dünü topla
    this.timer = setInterval(
      () => {
        void this.maybeRunDaily().catch((err) =>
          this.logger.error("Daily metrics tick failed", err as Error),
        );
      },
      60 * 60 * 1000,
    );
    void this.maybeRunDaily().catch((err) =>
      this.logger.warn(`Initial metrics skip: ${(err as Error).message}`),
    );
  }

  async maybeRunDaily() {
    const yesterday = utcDayOffset(-1);
    const key = yesterday.toISOString().slice(0, 10);
    if (this.lastRunDay === key) return { skipped: true, day: key };
    const result = await this.runDailySnapshot(yesterday);
    this.lastRunDay = key;
    return result;
  }

  /** Belirli gün için mağaza bazlı sipariş özeti → DailyStoreMetric */
  async runDailySnapshot(day: Date = utcDayOffset(-1), organizationId?: string) {
    const dayStart = startOfUtcDay(day);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const stores = await this.prisma.store.findMany({
      where: organizationId ? { organizationId } : undefined,
      select: { id: true, organizationId: true, name: true },
    });

    let upserted = 0;
    for (const store of stores) {
      const agg = await this.prisma.order.aggregate({
        where: {
          storeId: store.id,
          orderedAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { grossAmount: true, netProfit: true },
        _count: true,
      });

      const gross = Number(agg._sum.grossAmount ?? 0);
      const net = Number(agg._sum.netProfit ?? 0);
      const orderCount = agg._count;
      const marginPct = gross > 0 ? (net / gross) * 100 : 0;

      await this.prisma.dailyStoreMetric.upsert({
        where: {
          storeId_day: { storeId: store.id, day: dayStart },
        },
        create: {
          organizationId: store.organizationId,
          storeId: store.id,
          day: dayStart,
          orderCount,
          grossAmount: gross,
          netProfit: net,
          marginPct,
        },
        update: {
          orderCount,
          grossAmount: gross,
          netProfit: net,
          marginPct,
        },
      });
      upserted += 1;
    }

    this.logger.log(
      `Daily metrics: day=${dayStart.toISOString().slice(0, 10)} stores=${upserted}`,
    );

    return {
      day: dayStart.toISOString().slice(0, 10),
      stores: upserted,
      organizationId: organizationId ?? null,
    };
  }

  async listRecent(organizationId: string, days = 7) {
    const since = utcDayOffset(-(days - 1));
    const rows = await this.prisma.dailyStoreMetric.findMany({
      where: {
        organizationId,
        day: { gte: startOfUtcDay(since) },
      },
      orderBy: [{ day: "desc" }, { storeId: "asc" }],
      take: 200,
    });
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      storeId: r.storeId,
      orderCount: r.orderCount,
      grossAmount: Number(r.grossAmount),
      netProfit: Number(r.netProfit),
      marginPct: Number(r.marginPct),
    }));
  }
}

function utcDayOffset(offsetDays: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
