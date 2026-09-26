import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { TariffsService } from "../tariffs/tariffs.service";
import type { EnqueueDigestDto, UpdateMailPrefsDto } from "./dto";

export type MailPrefs = {
  email: string;
  daily: boolean;
  monthly: boolean;
  tariffChange: boolean;
  sendHourUtc: number;
  updatedAt: string;
};

export type DigestJob = {
  id: string;
  organizationId: string;
  cadence: "daily" | "monthly";
  email: string;
  status: "queued" | "sent" | "failed" | "skipped";
  createdAt: string;
  sentAt?: string;
  note?: string;
};

@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly logger = new Logger(ReportsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tariffs: TariffsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(
      () => {
        void this.runScheduledDigests().catch((err) =>
          this.logger.error("Digest schedule tick failed", err as Error),
        );
      },
      15 * 60 * 1000,
    );
    void this.runScheduledDigests().catch((err) =>
      this.logger.warn(`Initial digest tick skip: ${(err as Error).message}`),
    );
  }

  async getMailPrefs(organizationId: string): Promise<MailPrefs> {
    const row = await this.prisma.reportMailPref.findUnique({
      where: { organizationId },
    });
    if (!row) {
      return {
        email: "",
        daily: false,
        monthly: false,
        tariffChange: false,
        sendHourUtc: 6,
        updatedAt: new Date(0).toISOString(),
      };
    }
    return {
      email: row.email,
      daily: row.daily,
      monthly: row.monthly,
      tariffChange: row.tariffChange,
      sendHourUtc: clampHour(row.sendHourUtc),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async saveMailPrefs(
    organizationId: string,
    dto: UpdateMailPrefsDto,
  ): Promise<MailPrefs> {
    const email = dto.email.trim().toLowerCase();
    const sendHourUtc = clampHour(dto.sendHourUtc ?? 6);
    const tariffChange = Boolean(dto.tariffChange);
    const row = await this.prisma.reportMailPref.upsert({
      where: { organizationId },
      create: {
        organizationId,
        email,
        daily: dto.daily,
        monthly: dto.monthly,
        tariffChange,
        sendHourUtc,
      },
      update: {
        email,
        daily: dto.daily,
        monthly: dto.monthly,
        tariffChange,
        sendHourUtc,
      },
    });
    this.logger.log(
      `Mail prefs saved org=${organizationId} daily=${row.daily} monthly=${row.monthly} tariffChange=${row.tariffChange} hour=${row.sendHourUtc}`,
    );
    return {
      email: row.email,
      daily: row.daily,
      monthly: row.monthly,
      tariffChange: row.tariffChange,
      sendHourUtc: clampHour(row.sendHourUtc),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Standart vs Plus tarife net kâr karşılaştırması (katalog taraması). */
  async plusVsStandard(organizationId: string) {
    const { calculateNetProfit } = await import("../profit/profit.engine");
    const products = await this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        sku: true,
        title: true,
        category: true,
        salePrice: true,
        costPrice: true,
        commissionRate: true,
        shippingCost: true,
        store: { select: { id: true, name: true, marketplace: true } },
      },
      take: 200,
      orderBy: { title: "asc" },
    });

    const items = [];
    let totalStandardNet = 0;
    let totalPlusNet = 0;
    let withTariff = 0;

    for (const p of products) {
      if (!p.store) continue;
      const resolved = await this.tariffs.resolveForProduct(
        organizationId,
        p.store.marketplace,
        p.category,
        p.store.id,
      );
      if (!resolved) continue;
      withTariff += 1;
      const sale = Number(p.salePrice);
      const cost = Number(p.costPrice);
      const ship = Number(p.shippingCost);
      const std = estimateNet(calculateNetProfit, sale, cost, resolved.rate, ship);
      const plus = estimateNet(
        calculateNetProfit,
        sale,
        cost,
        resolved.plusRate,
        ship,
      );
      totalStandardNet += std;
      totalPlusNet += plus;
      items.push({
        productId: p.id,
        sku: p.sku,
        title: p.title,
        storeName: p.store.name,
        marketplace:
          p.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol",
        category: resolved.category,
        standardRatePct: resolved.ratePct,
        plusRatePct: resolved.plusRatePct,
        standardNet: std,
        plusNet: plus,
        deltaNet: round2(plus - std),
        isOverride: Boolean(resolved.isOverride),
      });
    }

    items.sort((a, b) => a.deltaNet - b.deltaNet);
    const deltaTotal = round2(totalPlusNet - totalStandardNet);

    return {
      items,
      summary: {
        productCount: items.length,
        scanned: products.length,
        withTariff,
        totalStandardNet: round2(totalStandardNet),
        totalPlusNet: round2(totalPlusNet),
        deltaTotal,
        winner:
          Math.abs(deltaTotal) < 0.01
            ? ("tie" as const)
            : deltaTotal > 0
              ? ("standard" as const)
              : ("plus" as const),
      },
      message:
        items.length > 0
          ? `Plus − Standart toplam net: ${deltaTotal >= 0 ? "+" : ""}${deltaTotal.toFixed(2)} ₺ (${items.length} ürün).`
          : "Karşılaştırılacak tarife/ürün yok.",
    };
  }

  /** Siparişleri ürün kategorisine göre net kâr özeti. */
  async categoryProfit(organizationId: string, days = 30) {
    const window = [7, 30, 90].includes(days) ? days : 30;
    const since = new Date(Date.now() - window * 86400_000);
    const orders = await this.prisma.order.findMany({
      where: { organizationId, orderedAt: { gte: since } },
      select: {
        grossAmount: true,
        netProfit: true,
        status: true,
        items: {
          take: 1,
          select: {
            product: { select: { category: true, title: true } },
          },
        },
      },
      take: 2000,
      orderBy: { orderedAt: "desc" },
    });

    const buckets = new Map<
      string,
      { category: string; gross: number; net: number; orderCount: number }
    >();
    for (const o of orders) {
      const cat =
        o.items[0]?.product?.category?.trim() ||
        "Diğer";
      const cur = buckets.get(cat) ?? {
        category: cat,
        gross: 0,
        net: 0,
        orderCount: 0,
      };
      cur.gross += Number(o.grossAmount);
      cur.net += Number(o.netProfit);
      cur.orderCount += 1;
      buckets.set(cat, cur);
    }

    const items = [...buckets.values()]
      .map((b) => ({
        category: b.category,
        orderCount: b.orderCount,
        gross: round2(b.gross),
        net: round2(b.net),
        marginPct: b.gross > 0 ? round2((b.net / b.gross) * 100) : 0,
      }))
      .sort((a, b) => b.net - a.net);

    const totalGross = items.reduce((s, i) => s + i.gross, 0);
    const totalNet = items.reduce((s, i) => s + i.net, 0);

    return {
      days: window,
      items,
      summary: {
        categoryCount: items.length,
        orderCount: orders.length,
        gross: round2(totalGross),
        net: round2(totalNet),
        marginPct: totalGross > 0 ? round2((totalNet / totalGross) * 100) : 0,
      },
      message:
        items.length > 0
          ? `${window} günde ${items.length} kategori · net ${round2(totalNet).toLocaleString("tr-TR")} ₺.`
          : `${window} günde kategori özeti için sipariş yok.`,
    };
  }

  /** Tercihi açık org’lar için saat penceresinde otomatik özet. */
  async runScheduledDigests() {
    const hour = new Date().getUTCHours();
    const prefs = await this.prisma.reportMailPref.findMany({
      where: {
        email: { not: "" },
        OR: [{ daily: true }, { monthly: true }],
      },
      take: 200,
    });

    let sent = 0;
    let skipped = 0;
    for (const pref of prefs) {
      if (clampHour(pref.sendHourUtc) !== hour) {
        skipped += 1;
        continue;
      }
      if (pref.daily) {
        const due = await this.needsDigest(pref.organizationId, "daily");
        if (due) {
          await this.enqueueDigest(pref.organizationId, {
            cadence: "daily",
            note: "Zamanlanmış günlük özet",
          });
          sent += 1;
        }
      }
      if (pref.monthly && isFirstDayOfMonthUtc()) {
        const due = await this.needsDigest(pref.organizationId, "monthly");
        if (due) {
          await this.enqueueDigest(pref.organizationId, {
            cadence: "monthly",
            note: "Zamanlanmış aylık özet",
          });
          sent += 1;
        }
      }
    }
    if (sent > 0) {
      this.logger.log(`Scheduled digests sent=${sent} hour=${hour}`);
    }
    const flushed = await this.flushPendingJobs();
    return { hour, considered: prefs.length, sent, skipped, flushed };
  }

  /** Başarısız veya takılı kuyruk kayıtlarını yeniden dener. */
  async retryFailed(organizationId: string) {
    const rows = await this.prisma.reportDigestJob.findMany({
      where: {
        organizationId,
        status: { in: ["failed", "queued"] },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const results: DigestJob[] = [];
    for (const row of rows) {
      const cadence =
        row.cadence === "monthly" ? ("monthly" as const) : ("daily" as const);
      const payload = await this.buildDigestPayload(
        organizationId,
        cadence,
      );
      const delivered = await this.deliverJob(row.id, {
        ...payload,
        email: row.email || payload.email,
      });
      results.push(delivered);
    }
    return {
      retried: results.length,
      jobs: results,
      message:
        results.length > 0
          ? `${results.length} kuyruk kaydı yeniden denendi.`
          : "Yeniden denenecek başarısız kayıt yok.",
    };
  }

  /** Zamanlayıcı: takılı queued kayıtları boşalt. */
  private async flushPendingJobs() {
    const stuck = await this.prisma.reportDigestJob.findMany({
      where: {
        status: "queued",
        createdAt: { lte: new Date(Date.now() - 60_000) },
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    let flushed = 0;
    for (const row of stuck) {
      const cadence =
        row.cadence === "monthly" ? ("monthly" as const) : ("daily" as const);
      const payload = await this.buildDigestPayload(
        row.organizationId,
        cadence,
      );
      await this.deliverJob(row.id, {
        ...payload,
        email: row.email || payload.email,
      });
      flushed += 1;
    }
    return flushed;
  }

  async enqueueDigest(
    organizationId: string,
    dto: EnqueueDigestDto,
  ): Promise<DigestJob> {
    const prefs = await this.getMailPrefs(organizationId);
    const enabled = dto.cadence === "daily" ? prefs.daily : prefs.monthly;
    const payload = await this.buildDigestPayload(organizationId, dto.cadence);

    if (!prefs.email) {
      return this.createJob(organizationId, dto.cadence, "", "skipped", payload, {
        note: dto.note ?? "E-posta adresi yok",
      });
    }
    if (!enabled) {
      return this.createJob(
        organizationId,
        dto.cadence,
        prefs.email,
        "skipped",
        payload,
        { note: dto.note ?? "Bu periyot tercihte kapalı" },
      );
    }

    const queued = await this.createJob(
      organizationId,
      dto.cadence,
      prefs.email,
      "queued",
      payload,
      { note: dto.note ?? "Özet kuyruğa alındı" },
    );

    return this.deliverJob(queued.id, payload);
  }

  async listJobs(organizationId: string): Promise<DigestJob[]> {
    const rows = await this.prisma.reportDigestJob.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map((row) => this.mapJob(row));
  }

  async buildDigestPayload(
    organizationId: string,
    cadence: "daily" | "monthly",
  ) {
    const prefs = await this.getMailPrefs(organizationId);
    const since =
      cadence === "daily"
        ? new Date(Date.now() - 86400_000)
        : new Date(Date.now() - 30 * 86400_000);

    const orders = await this.prisma.order.findMany({
      where: {
        organizationId,
        orderedAt: { gte: since },
      },
      select: {
        grossAmount: true,
        netProfit: true,
        status: true,
      },
      take: 2000,
    });

    const orderCount = orders.length;
    const gross = orders.reduce((s, o) => s + Number(o.grossAmount), 0);
    const net = orders.reduce((s, o) => s + Number(o.netProfit), 0);
    const returns = orders.filter((o) => o.status === "RETURNED").length;
    const marginPct = gross > 0 ? Math.round((net / gross) * 1000) / 10 : 0;

    const mismatches = await this.tariffs
      .listMismatches(organizationId, 40)
      .catch(() => ({ items: [] as Array<{ sku: string | null; title: string; deltaPct: number }>, total: 0 }));
    const tariffMismatchCount =
      typeof mismatches.total === "number"
        ? mismatches.total
        : mismatches.items?.length ?? 0;
    const tariffTop = (mismatches.items ?? []).slice(0, 5).map((i) => ({
      sku: i.sku,
      title: i.title,
      deltaPct: i.deltaPct,
    }));

    return {
      organizationId,
      cadence,
      email: prefs.email || null,
      generatedAt: new Date().toISOString(),
      title:
        cadence === "daily" ? "Cirofy günlük özet" : "Cirofy aylık özet",
      metrics: {
        orderCount,
        grossAmount: Math.round(gross * 100) / 100,
        netProfit: Math.round(net * 100) / 100,
        marginPct,
        returnCount: returns,
        periodDays: cadence === "daily" ? 1 : 30,
        tariffMismatchCount,
      },
      tariff: {
        mismatchCount: tariffMismatchCount,
        top: tariffTop,
        note:
          tariffMismatchCount > 0
            ? `${tariffMismatchCount} üründe komisyon tarifeden sapıyor.`
            : "Komisyon tarifesiyle uyumlu.",
      },
      sections: [
        "net_profit",
        "margin",
        "orders",
        "category_profit",
        "returns",
        "tariff_mismatch",
      ],
      formatHints: {
        csv: "Özet ve kategori satırlarını istemci üretir",
        printPdf: "Tarayıcı yazdır / PDF kaydet",
      },
      message: "Özet paketi hazır. Panelden indirebilir veya e-posta ile alabilirsiniz.",
    };
  }

  private async needsDigest(
    organizationId: string,
    cadence: "daily" | "monthly",
  ) {
    const since =
      cadence === "daily"
        ? startOfUtcDay(new Date())
        : startOfUtcMonth(new Date());
    const existing = await this.prisma.reportDigestJob.findFirst({
      where: {
        organizationId,
        cadence,
        status: "sent",
        OR: [
          { sentAt: { gte: since } },
          { createdAt: { gte: since }, sentAt: { not: null } },
        ],
      },
      select: { id: true },
    });
    return !existing;
  }

  private async deliverJob(
    jobId: string,
    payload: Awaited<ReturnType<ReportsService["buildDigestPayload"]>>,
  ): Promise<DigestJob> {
    const row = await this.prisma.reportDigestJob.findUnique({
      where: { id: jobId },
    });
    if (!row) {
      throw new Error("Kuyruk kaydı bulunamadı");
    }

    const m = payload.metrics;
    const tariffNote = payload.tariff?.note ?? null;
    const tariffLines =
      payload.tariff?.top?.length
        ? payload.tariff.top.map(
            (t) =>
              `  - ${t.sku || t.title}: Δ ${t.deltaPct > 0 ? "+" : ""}${t.deltaPct}p`,
          )
        : [];
    const text = [
      payload.title,
      "",
      `Dönem: son ${m.periodDays} gün`,
      `Sipariş: ${m.orderCount}`,
      `Ciro: ${formatTryText(m.grossAmount)}`,
      `Net kâr: ${formatTryText(m.netProfit)}`,
      `Marj: %${m.marginPct}`,
      `İade: ${m.returnCount}`,
      `Tarife sapması: ${m.tariffMismatchCount ?? 0} ürün`,
      ...(tariffNote ? ["", tariffNote, ...tariffLines] : []),
      "",
      "Detaylı rapor için Cirofy paneline giriş yapın.",
      "— Cirofy",
    ].join("\n");

    const tariffHtml =
      (m.tariffMismatchCount ?? 0) > 0
        ? `<li>Tarife sapması: <strong style="color:#b45309">${m.tariffMismatchCount} ürün</strong></li>`
        : `<li>Tarife sapması: <strong>0</strong></li>`;

    const html = `<div style="font-family:system-ui,sans-serif;color:#0B1424;line-height:1.5">
  <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(payload.title)}</h1>
  <p style="margin:0 0 8px;color:#64748b">Son ${m.periodDays} gün</p>
  <ul style="padding-left:18px;margin:0 0 16px">
    <li>Sipariş: <strong>${m.orderCount}</strong></li>
    <li>Ciro: <strong>${escapeHtml(formatTryText(m.grossAmount))}</strong></li>
    <li>Net kâr: <strong style="color:#0DBF9B">${escapeHtml(formatTryText(m.netProfit))}</strong></li>
    <li>Marj: <strong>%${m.marginPct}</strong></li>
    <li>İade: <strong>${m.returnCount}</strong></li>
    ${tariffHtml}
  </ul>
  ${
    tariffNote
      ? `<p style="margin:0 0 12px;font-size:13px;color:#9a3412">${escapeHtml(tariffNote)}</p>`
      : ""
  }
  <p style="margin:0;color:#64748b;font-size:13px">Detaylı rapor için Cirofy paneline giriş yapın.</p>
</div>`;

    const result = await this.mail.send({
      to: row.email,
      subject: payload.title,
      text,
      html,
    });

    let status: DigestJob["status"] = "failed";
    let note = "E-posta gönderilemedi";
    if (result.ok) {
      status = "sent";
      note =
        result.mode === "smtp"
          ? "Özet e-posta gönderildi"
          : "Özet kuyruğa alındı";
    } else {
      note = result.error;
    }

    const updated = await this.prisma.reportDigestJob.update({
      where: { id: jobId },
      data: {
        status,
        note,
        sentAt: result.ok ? new Date() : null,
      },
    });

    this.logger.log(
      `Digest ${status} org=${row.organizationId} cadence=${row.cadence}`,
    );
    return this.mapJob(updated);
  }

  private async createJob(
    organizationId: string,
    cadence: "daily" | "monthly",
    email: string,
    status: DigestJob["status"],
    payload: object,
    opts: { note?: string },
  ): Promise<DigestJob> {
    const row = await this.prisma.reportDigestJob.create({
      data: {
        organizationId,
        cadence,
        email,
        status,
        note: opts.note,
        payload: payload as object,
      },
    });
    return this.mapJob(row);
  }

  private mapJob(row: {
    id: string;
    organizationId: string;
    cadence: string;
    email: string;
    status: string;
    note: string | null;
    createdAt: Date;
    sentAt?: Date | null;
  }): DigestJob {
    return {
      id: row.id,
      organizationId: row.organizationId,
      cadence: row.cadence as "daily" | "monthly",
      email: row.email,
      status: normalizeStatus(row.status),
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : undefined,
      note: row.note ?? undefined,
    };
  }
}

function clampHour(n: number) {
  if (!Number.isFinite(n)) return 6;
  return Math.max(0, Math.min(23, Math.round(n)));
}

function isFirstDayOfMonthUtc() {
  return new Date().getUTCDate() === 1;
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function normalizeStatus(raw: string): DigestJob["status"] {
  if (raw === "sent" || raw === "sent_mock") return "sent";
  if (raw === "failed") return "failed";
  if (raw === "skipped") return "skipped";
  return "queued";
}

function formatTryText(n: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(n);
}

function estimateNet(
  calc: typeof import("../profit/profit.engine").calculateNetProfit,
  sale: number,
  cost: number,
  rate: number,
  ship: number,
) {
  const profit = calc({
    grossAmount: sale,
    commission: sale * rate,
    shippingFee: ship,
    serviceFee: Math.max(4, sale * 0.015),
    vatNet: sale * 0.02,
    withholding: sale * 0.01,
    costTotal: cost,
  });
  return round2(profit.netProfit);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
