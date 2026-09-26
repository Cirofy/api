import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { calculateNetProfit } from "../profit/profit.engine";
import { TariffsService } from "../tariffs/tariffs.service";

export type NotificationEventInput = {
  dedupeKey: string;
  title: string;
  body: string;
  tone: "profit" | "loss" | "warn";
  href: string;
  actionLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TariffsService))
    private readonly tariffs: TariffsService,
  ) {}

  async list(organizationId: string) {
    await this.scanOrganization(organizationId);
    const rows = await this.prisma.notification.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    return rows
      .map((n) => {
        const kind = notificationKind(n.dedupeKey, n.title, n.href);
        const priority = notificationPriority({
          kind,
          tone: n.tone,
          readAt: n.readAt,
          dedupeKey: n.dedupeKey,
        });
        return {
          id: n.id,
          title: n.title,
          body: n.body,
          tone: n.tone as "profit" | "loss" | "warn",
          href: n.href,
          actionLabel: n.actionLabel,
          secondaryHref: n.secondaryHref ?? undefined,
          secondaryLabel: n.secondaryLabel ?? undefined,
          readAt: n.readAt?.toISOString() ?? null,
          createdAt: n.createdAt.toISOString(),
          time: relativeTr(n.createdAt),
          kind,
          priority,
          priorityLabel:
            kind === "tariff" && !n.readAt
              ? "Tarife · öncelikli"
              : null,
        };
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
  }

  async markRead(organizationId: string, id: string) {
    const row = await this.prisma.notification.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException("Bildirim bulunamadı");
    const updated = await this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    return {
      id: updated.id,
      readAt: updated.readAt?.toISOString() ?? null,
    };
  }

  async markAllRead(organizationId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /** Aynı dedupeKey için okunmamış veya 24s içindeki kaydı tekrarlamaz. */
  async emitEvent(organizationId: string, event: NotificationEventInput) {
    const existing = await this.prisma.notification.findFirst({
      where: { organizationId, dedupeKey: event.dedupeKey },
    });
    if (existing) {
      const ageMs = Date.now() - existing.createdAt.getTime();
      const fresh = !existing.readAt || ageMs < 24 * 3600_000;
      if (fresh) return existing;
      return this.prisma.notification.update({
        where: { id: existing.id },
        data: {
          title: event.title,
          body: event.body,
          tone: event.tone,
          href: event.href,
          actionLabel: event.actionLabel,
          secondaryHref: event.secondaryHref ?? null,
          secondaryLabel: event.secondaryLabel ?? null,
          readAt: null,
          createdAt: new Date(),
        },
      });
    }

    try {
      return await this.prisma.notification.create({
        data: {
          organizationId,
          dedupeKey: event.dedupeKey,
          title: event.title,
          body: event.body,
          tone: event.tone,
          href: event.href,
          actionLabel: event.actionLabel,
          secondaryHref: event.secondaryHref ?? null,
          secondaryLabel: event.secondaryLabel ?? null,
        },
      });
    } catch (err) {
      this.logger.debug(`emitEvent race for ${event.dedupeKey}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Ürün + buybox yakalamalarından olay üretir.
   * Pull sonrası ve liste çağrısında güvenle tekrarlanabilir.
   */
  async scanOrganization(organizationId: string) {
    const [products, captures, returnedCount, openSettlements, orderMonthCount, sub, tariffMismatches] =
      await Promise.all([
        this.prisma.product.findMany({
          where: { organizationId, isActive: true },
          take: 200,
          orderBy: { updatedAt: "desc" },
        }),
        this.prisma.buyboxCapture.findMany({
          where: { organizationId },
          orderBy: { capturedAt: "desc" },
          take: 80,
        }),
        this.prisma.order.count({
          where: {
            organizationId,
            status: "RETURNED",
            orderedAt: { gte: new Date(Date.now() - 30 * 86400_000) },
          },
        }),
        this.prisma.settlementIssue.count({
          where: { organizationId, status: "open" },
        }),
        this.prisma.order.count({
          where: {
            organizationId,
            orderedAt: { gte: startOfMonthUtc() },
          },
        }),
        this.prisma.subscription.findUnique({
          where: { organizationId },
          select: { planId: true },
        }),
        this.tariffs.listMismatches(organizationId, 50).catch(() => ({
          items: [] as Array<{ sku: string | null; title: string; deltaPct: number }>,
          total: 0,
        })),
      ]);
    if (products.length === 0 && captures.length === 0 && openSettlements === 0) {
      return { emitted: 0 };
    }

    let emitted = 0;
    const lowMargin: Array<{ sku: string; label: string }> = [];
    const highReturn: Array<{ sku: string; label: string }> = [];
    const lowStock: Array<{ sku: string; label: string }> = [];
    const buyboxRisk: Array<{ sku: string; label: string }> = [];
    const missingDesi: Array<{ sku: string; label: string }> = [];
    const bySku = new Map(
      products.filter((p) => p.sku).map((p) => [p.sku as string, p]),
    );

    for (const p of products) {
      const sale = Number(p.salePrice);
      const cost = Number(p.costPrice);
      const rate = Number(p.commissionRate);
      const ship = Number(p.shippingCost);
      const ret = Number(p.returnRatePct);
      const stock = p.stockQty;
      const desi = Number(p.desi);

      const gross = sale;
      const commission = gross * rate;
      const serviceFee = Math.max(4, gross * 0.015);
      const vatNet = gross * 0.02;
      const withholding = gross * 0.01;
      const profit = calculateNetProfit({
        grossAmount: gross,
        commission,
        shippingFee: ship,
        serviceFee,
        vatNet,
        withholding,
        costTotal: cost,
      });

      const sku = p.sku || p.id;
      const label = p.sku || p.title.slice(0, 28);
      const entry = { sku, label };

      if (profit.marginPct < 8 && sale > 0) lowMargin.push(entry);
      if (ret >= 8) highReturn.push(entry);
      if (stock != null && stock <= 5) lowStock.push(entry);
      if (profit.marginPct < 12 && profit.marginPct >= 8 && sale > 0) {
        buyboxRisk.push(entry);
      }
      if (desi <= 0) missingDesi.push(entry);
    }

    if (lowMargin.length > 0) {
      const top = lowMargin[0]!;
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:low-margin",
        title: "Kritik marj",
        body: `${lowMargin.length} SKU hedef marjın altında (${preview(lowMargin.map((x) => x.label))}).`,
        tone: "loss",
        href: `/pricing?sku=${encodeURIComponent(top.sku)}`,
        actionLabel: "Fiyat öner",
        secondaryHref: "/pricing",
        secondaryLabel: "Tüm fiyat motoru",
      });
      if (n) emitted += 1;
    }

    if (highReturn.length > 0) {
      const top = highReturn[0]!;
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:high-return",
        title: "Yüksek iade",
        body: `${highReturn.length} üründe iade oranı yüksek (${preview(highReturn.map((x) => x.label))}).`,
        tone: "warn",
        href: "/returns",
        actionLabel: "İade zararını aç",
        secondaryHref: `/products?q=${encodeURIComponent(top.sku)}`,
        secondaryLabel: "Ürünü aç",
      });
      if (n) emitted += 1;
    }

    if (lowStock.length > 0) {
      const top = lowStock[0]!;
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:low-stock",
        title: "Düşük stok",
        body: `${lowStock.length} SKU’da stok 5 veya altında (${preview(lowStock.map((x) => x.label))}).`,
        tone: "warn",
        href: `/products?q=${encodeURIComponent(top.sku)}`,
        actionLabel: "Stoku kontrol et",
        secondaryHref: "/radar",
        secondaryLabel: "Radar’ı aç",
      });
      if (n) emitted += 1;
    }

    if (missingDesi.length > 0) {
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:missing-desi",
        title: "Desi eksik",
        body: `${missingDesi.length} üründe desi tanımsız — kargo sapması güvenilmez (${preview(missingDesi.map((x) => x.label))}).`,
        tone: "warn",
        href: "/settlements",
        actionLabel: "Hakedişe bak",
        secondaryHref: "/products",
        secondaryLabel: "Desiyi düzelt",
      });
      if (n) emitted += 1;
    }

    if (buyboxRisk.length > 0) {
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:buybox-risk",
        title: "Buybox riski",
        body: `${buyboxRisk.length} SKU’da marj dar; fiyat düşürmek buybox’ı kaybettirebilir (${preview(buyboxRisk.map((x) => x.label))}).`,
        tone: "warn",
        href: "/buybox",
        actionLabel: "Buybox’ı aç",
        secondaryHref: "/scenarios",
        secondaryLabel: "Senaryo dene",
      });
      if (n) emitted += 1;
    }

    if (returnedCount >= 3) {
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:returns-volume",
        title: "İade yoğunluğu",
        body: `Son 30 günde ${returnedCount} iade siparişi var.`,
        tone: "warn",
        href: "/returns",
        actionLabel: "Zarar analizini aç",
        secondaryHref: "/orders",
        secondaryLabel: "İade siparişleri",
      });
      if (n) emitted += 1;
    }

    if (openSettlements > 0) {
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:settlement-open",
        title: "Açık hakediş sapması",
        body: `${openSettlements} açık sapma satırı var — itiraz paketini kontrol edin.`,
        tone: "loss",
        href: "/settlements",
        actionLabel: "Hakedişi aç",
        secondaryHref: "/support",
        secondaryLabel: "Destek talebi",
      });
      if (n) emitted += 1;
    }

    const mismatchItems = tariffMismatches.items ?? [];
    if (mismatchItems.length > 0) {
      const top = mismatchItems[0]!;
      const labels = mismatchItems
        .slice(0, 3)
        .map((x) => x.sku || x.title.slice(0, 24));
      const critical = mismatchItems.length >= 8;
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:tariff-mismatch",
        title: critical ? "Kritik tarife sapması" : "Tarife sapması",
        body: `${mismatchItems.length} üründe komisyon tarifeden sapıyor (${preview(labels)}).`,
        tone: critical ? "loss" : "warn",
        href: top.sku
          ? `/pricing?sku=${encodeURIComponent(top.sku)}&tariff=1`
          : "/products?tariff=1",
        actionLabel: critical ? "Öncelikli düzelt" : "Ürünlerde düzelt",
        secondaryHref: "/tariffs",
        secondaryLabel: "Tarifeler",
      });
      if (n) emitted += 1;
    }

    const planId = (sub?.planId ?? "STARTER") as string;
    const orderLimit =
      planId === "ENTERPRISE" ? 30_000 : planId === "BUSINESS" ? 5000 : 1000;
    if (orderLimit > 0 && orderMonthCount / orderLimit >= 0.8) {
      const pct = Math.min(100, Math.round((orderMonthCount / orderLimit) * 100));
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:quota-near",
        title: "Kota yaklaşıyor",
        body: `Aylık sipariş kotasının %${pct}’i doldu (${orderMonthCount}/${orderLimit}).`,
        tone: pct >= 100 ? "loss" : "warn",
        href: "/billing",
        actionLabel: "Aboneliği aç",
        secondaryHref: "/live",
        secondaryLabel: "Gün içi",
      });
      if (n) emitted += 1;
    }

    const lost = captures
      .map((c) => {
        const product = bySku.get(c.sku);
        const our = Number(c.ourPrice ?? product?.salePrice ?? 0);
        const box = Number(c.buyboxPrice);
        if (!our || !box || our <= box + 0.01) return null;
        return {
          sku: c.sku,
          buyboxPrice: box,
          ourPrice: our,
          title: product?.title?.slice(0, 40) || c.sku,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .slice(0, 5);

    for (const row of lost) {
      const href = `/pricing?sku=${encodeURIComponent(row.sku)}&buybox=${row.buyboxPrice}`;
      const n = await this.emitEvent(organizationId, {
        dedupeKey: `scan:buybox-lost:${row.sku}`,
        title: "Buybox kaybı",
        body: `${row.title}: bizim ₺${round2(row.ourPrice)} · buybox ₺${round2(row.buyboxPrice)}.`,
        tone: "loss",
        href,
        actionLabel: "Fiyat öner",
        secondaryHref: `/buybox?sku=${encodeURIComponent(row.sku)}`,
        secondaryLabel: "Buybox satırı",
      });
      if (n) emitted += 1;
    }

    if (lost.length > 1) {
      const n = await this.emitEvent(organizationId, {
        dedupeKey: "scan:buybox-lost-summary",
        title: "Buybox kayıpları",
        body: `${lost.length} SKU’da rakip önde (${preview(lost.map((l) => l.sku))}).`,
        tone: "loss",
        href: "/buybox?onlyLost=1",
        actionLabel: "Kayıpları gör",
        secondaryHref: "/extension",
        secondaryLabel: "Eklenti yakala",
      });
      if (n) emitted += 1;
    }

    return { emitted, message: `${emitted} olay güncellendi.` };
  }

}

function preview(labels: string[]) {
  return labels.slice(0, 2).join(", ") + (labels.length > 2 ? "…" : "");
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function relativeTr(d: Date) {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} dk önce`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.round(hours / 24)} g önce`;
}

function startOfMonthUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function notificationKind(
  dedupeKey: string | null | undefined,
  title: string,
  href: string,
): "tariff" | "settlement" | "buybox" | "quota" | "other" {
  const key = (dedupeKey ?? "").toLowerCase();
  if (key.includes("tariff") || href.includes("tariff=1") || title.toLowerCase().includes("tarif")) {
    return "tariff";
  }
  if (key.includes("settlement") || href.includes("/settlements")) return "settlement";
  if (key.includes("buybox") || href.includes("/buybox")) return "buybox";
  if (key.includes("quota") || href.includes("/billing")) return "quota";
  return "other";
}

/** Düşük sayı = daha yüksek öncelik (liste başı). */
function notificationPriority(input: {
  kind: string;
  tone: string;
  readAt: Date | null;
  dedupeKey: string | null | undefined;
}): number {
  if (input.readAt) return 90;
  if (input.kind === "tariff") return 0;
  if (input.kind === "settlement" || input.dedupeKey === "scan:settlement-open") {
    return 1;
  }
  if (input.tone === "loss") return 2;
  if (input.tone === "warn") return 3;
  return 5;
}
