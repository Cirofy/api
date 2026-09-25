import type { PulledCommissionRate } from "./commission-rates";
import { normalizeCommissionRate } from "./commission-rates";
import type {
  CommissionPullOptions,
  MarketplaceAdapter,
  MarketplaceCredentials,
  MarketplacePullResult,
  OtherFinancialPullOptions,
  PulledFinancialFeeRow,
  PulledSettlementRow,
  SettlementPullOptions,
} from "./marketplace.types";
import { mapPartnerPayload } from "./partner-mappers";
import { MarketplacePullError } from "./pull-error";

const DEFAULT_BASE = "https://apigw.trendyol.com";
const PRODUCT_PAGE_SIZE = 200;
const ORDER_PAGE_SIZE = 200;
const MAX_PRODUCT_PAGES = 15;
const MAX_ORDER_PAGES = 15;
const SETTLEMENT_PAGE_SIZE = 500;
const MAX_SETTLEMENT_PAGES = 20;
const MAX_FINANCIAL_PAGES = 20;

/**
 * Trendyol partner okuma — ürün filtre + sipariş paketleri.
 * Auth: Basic(apiKey:apiSecret) + User-Agent "{sellerId} - {integrator}".
 */
export class TrendyolMarketplaceAdapter implements MarketplaceAdapter {
  readonly code = "TRENDYOL" as const;

  async pull(
    credentials: MarketplaceCredentials,
    options?: { sinceDays?: number },
  ): Promise<MarketplacePullResult> {
    const sellerId = credentials.externalStoreId?.trim();
    if (!sellerId) {
      throw new MarketplacePullError(
        "Satıcı ID gerekli. Mağaza bağlantısında satıcı numarasını girin.",
      );
    }
    if (!credentials.apiKey?.trim() || !credentials.apiSecret?.trim()) {
      throw new MarketplacePullError(
        "Entegrasyon anahtarları eksik. Bağlantıyı yeniden kaydedin.",
      );
    }

    const baseUrl = (
      process.env.TRENDYOL_API_BASE?.trim() || DEFAULT_BASE
    ).replace(/\/$/, "");
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const headers = this.authHeaders(credentials, sellerId);

    const sinceDays = options?.sinceDays ?? 7;
    const endMs = Date.now();
    const startMs = endMs - sinceDays * 86400_000;

    const productsJson = await this.fetchPages({
      baseUrl,
      path: `/integration/product/sellers/${encodeURIComponent(sellerId)}/products`,
      headers,
      timeoutMs,
      pageSize: PRODUCT_PAGE_SIZE,
      maxPages: MAX_PRODUCT_PAGES,
      query: { approved: "true" },
      label: "ürün",
    });

    const ordersJson = await this.fetchPages({
      baseUrl,
      path: `/integration/order/sellers/${encodeURIComponent(sellerId)}/orders`,
      headers,
      timeoutMs,
      pageSize: ORDER_PAGE_SIZE,
      maxPages: MAX_ORDER_PAGES,
      query: {
        startDate: String(startMs),
        endDate: String(endMs),
        orderByField: "PackageLastModifiedDate",
        orderByDirection: "DESC",
      },
      label: "sipariş",
      allowEmpty: true,
    });

    const mapped = mapPartnerPayload("TRENDYOL", productsJson, ordersJson);
    if (!mapped || mapped.products.length === 0) {
      throw new MarketplacePullError(
        "Pazaryerinden ürün alınamadı. Anahtarları ve satıcı ID’yi kontrol edin.",
      );
    }

    return {
      ...mapped,
      source: "live",
      note: `Trendyol canlı çekim: ${mapped.products.length} ürün, ${mapped.orders.length} sipariş satırı.`,
    };
  }

  /**
   * Cari ekstre (settlements) Sale satırlarından ürün komisyon oranı.
   * @see https://developers.trendyol.com/docs/cari-hesap-ekstresi-entegrasyonu
   */
  async pullCommissionRates(
    credentials: MarketplaceCredentials,
    options?: CommissionPullOptions,
  ): Promise<PulledCommissionRate[]> {
    const sellerId = credentials.externalStoreId?.trim();
    if (!sellerId) {
      throw new MarketplacePullError(
        "Satıcı ID gerekli. Mağaza bağlantısında satıcı numarasını girin.",
      );
    }
    if (!credentials.apiKey?.trim() || !credentials.apiSecret?.trim()) {
      throw new MarketplacePullError(
        "Entegrasyon anahtarları eksik. Bağlantıyı yeniden kaydedin.",
      );
    }

    const baseUrl = (
      process.env.TRENDYOL_API_BASE?.trim() || DEFAULT_BASE
    ).replace(/\/$/, "");
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const headers = this.authHeaders(credentials, sellerId);

    // Settlements max ~15 gün penceresi
    const sinceDays = Math.min(14, Math.max(1, options?.sinceDays ?? 14));
    const endMs = Date.now();
    const startMs = endMs - sinceDays * 86400_000;

    const byBarcode = new Map<string, string>();
    for (const p of options?.catalog ?? []) {
      const cat = (p.category || "Diğer").trim() || "Diğer";
      if (p.barcode) byBarcode.set(p.barcode.trim(), cat);
    }

    const rows: PulledCommissionRate[] = [];
    let page = 0;
    const maxPages = 20;

    while (page < maxPages) {
      const url = new URL(
        `/integration/finance/che/sellers/${encodeURIComponent(sellerId)}/settlements`,
        `${baseUrl}/`,
      );
      url.searchParams.set("transactionType", "Sale");
      url.searchParams.set("startDate", String(startMs));
      url.searchParams.set("endDate", String(endMs));
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", "500");

      const json = await this.getJson(url, headers, timeoutMs, "hakediş");
      const content = Array.isArray(json.content) ? json.content : [];

      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const rateRaw = Number(row.commissionRate);
        const rate = normalizeCommissionRate(rateRaw);
        if (rate == null) continue;
        const barcode =
          typeof row.barcode === "string" && row.barcode.trim()
            ? row.barcode.trim()
            : null;
        const category =
          (barcode && byBarcode.get(barcode)) ||
          "Diğer";
        rows.push({
          marketplace: "TRENDYOL",
          category,
          rate,
          plusRate: rate,
          barcode,
          note: "Trendyol hakediş · Sale",
        });
      }

      if (content.length === 0) break;
      if (content.length < 500) break;
      const totalPages = Number(json.totalPages);
      const totalElements = Number(json.totalElements);
      if (Number.isFinite(totalPages) && totalPages > 0 && page + 1 >= totalPages) {
        break;
      }
      if (
        Number.isFinite(totalElements) &&
        totalElements > 0 &&
        (page + 1) * 500 >= totalElements
      ) {
        break;
      }
      page += 1;
    }

    return rows;
  }

  async pullSettlements(
    credentials: MarketplaceCredentials,
    options: SettlementPullOptions,
  ): Promise<PulledSettlementRow[]> {
    const sellerId = this.requireSeller(credentials);
    const baseUrl = (
      process.env.TRENDYOL_API_BASE?.trim() || DEFAULT_BASE
    ).replace(/\/$/, "");
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const headers = this.authHeaders(credentials, sellerId);
    const sinceDays = Math.min(14, Math.max(1, options.sinceDays ?? 14));
    const endMs = Date.now();
    const startMs = endMs - sinceDays * 86400_000;

    const rows: PulledSettlementRow[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages && page < MAX_SETTLEMENT_PAGES) {
      const url = new URL(
        `/integration/finance/che/sellers/${encodeURIComponent(sellerId)}/settlements`,
        `${baseUrl}/`,
      );
      url.searchParams.set("transactionType", options.transactionType);
      url.searchParams.set("startDate", String(startMs));
      url.searchParams.set("endDate", String(endMs));
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(SETTLEMENT_PAGE_SIZE));

      const json = await this.getJson(url, headers, timeoutMs, "hakediş");
      const content = Array.isArray(json.content) ? json.content : [];
      const tp = Number(json.totalPages);
      totalPages =
        Number.isFinite(tp) && tp > 0
          ? tp
          : content.length < SETTLEMENT_PAGE_SIZE
            ? page + 1
            : page + 2;

      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        rows.push({
          transactionType: options.transactionType,
          orderId: this.firstString(row, [
            "orderNumber",
            "orderId",
            "shipmentPackageId",
            "id",
          ]),
          barcode: this.firstString(row, ["barcode", "stockCode"]),
          transactionDate: this.firstString(row, [
            "transactionDate",
            "paymentDate",
            "orderDate",
          ]),
          sellerRevenue: this.firstNumber(row, ["sellerRevenue"]),
          credit: this.firstNumber(row, ["credit"]),
          debt: this.firstNumber(row, ["debt"]),
          commissionAmount: this.firstNumber(row, [
            "commissionAmount",
            "commission",
          ]),
          paymentOrderId: this.firstString(row, [
            "paymentOrderId",
            "paymentOrder",
          ]),
          description: this.firstString(row, ["description", "transactionType"]),
        });
      }

      page += 1;
      if (content.length === 0) break;
    }

    return rows;
  }

  async pullOtherFinancials(
    credentials: MarketplaceCredentials,
    options: OtherFinancialPullOptions,
  ): Promise<PulledFinancialFeeRow[]> {
    const sellerId = this.requireSeller(credentials);
    const baseUrl = (
      process.env.TRENDYOL_API_BASE?.trim() || DEFAULT_BASE
    ).replace(/\/$/, "");
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const headers = this.authHeaders(credentials, sellerId);
    const sinceDays = Math.min(14, Math.max(1, options.sinceDays ?? 14));
    const endMs = Date.now();
    const startMs = endMs - sinceDays * 86400_000;

    const rows: PulledFinancialFeeRow[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages && page < MAX_FINANCIAL_PAGES) {
      const url = new URL(
        `/integration/finance/che/sellers/${encodeURIComponent(sellerId)}/otherfinancials`,
        `${baseUrl}/`,
      );
      url.searchParams.set("transactionType", options.transactionType);
      if (options.transactionSubType) {
        url.searchParams.set("transactionSubType", options.transactionSubType);
      }
      url.searchParams.set("startDate", String(startMs));
      url.searchParams.set("endDate", String(endMs));
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(SETTLEMENT_PAGE_SIZE));

      const json = await this.getJson(url, headers, timeoutMs, "finans");
      const content = Array.isArray(json.content) ? json.content : [];
      const tp = Number(json.totalPages);
      totalPages =
        Number.isFinite(tp) && tp > 0
          ? tp
          : content.length < SETTLEMENT_PAGE_SIZE
            ? page + 1
            : page + 2;

      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const amount =
          this.firstNumber(row, ["debt", "credit", "amount"]) ?? 0;
        if (amount === 0) continue;
        rows.push({
          amount: Math.abs(amount),
          transactionDate: this.firstString(row, [
            "transactionDate",
            "paymentDate",
          ]),
          description:
            this.firstString(row, ["description", "transactionSubType"]) ??
            options.transactionSubType ??
            options.transactionType,
          transactionType: options.transactionType,
          transactionSubType:
            this.firstString(row, ["transactionSubType"]) ??
            options.transactionSubType ??
            null,
        });
      }

      page += 1;
      if (content.length === 0) break;
    }

    return rows;
  }

  async pullAdsFees(
    credentials: MarketplaceCredentials,
    sinceDays = 14,
  ): Promise<PulledFinancialFeeRow[]> {
    // Resmi Ads API yok; otherfinancials DeductionInvoices üzerinden reklam/platform bedelleri
    const subtypes = [
      "PlatformServiceFee",
      "AdvertisingFee",
      "SponsoredProducts",
    ];
    const seen = new Set<string>();
    const out: PulledFinancialFeeRow[] = [];

    for (const transactionSubType of subtypes) {
      try {
        const rows = await this.pullOtherFinancials(credentials, {
          transactionType: "DeductionInvoices",
          transactionSubType,
          sinceDays,
        });
        for (const r of rows) {
          const key = `${r.transactionDate ?? ""}:${r.amount}:${r.description ?? ""}:${r.transactionSubType ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            ...r,
            description: r.description || "Platform hizmet bedeli",
          });
        }
      } catch {
        // Alt tip desteklenmiyorsa sessizce diğerlerini dene
      }
    }

    if (out.length === 0) {
      try {
        const fallback = await this.pullOtherFinancials(credentials, {
          transactionType: "DeductionInvoices",
          sinceDays,
        });
        for (const r of fallback) {
          const sub = (r.transactionSubType ?? "").toLowerCase();
          const desc = (r.description ?? "").toLowerCase();
          const isAd =
            sub.includes("platform") ||
            sub.includes("advertis") ||
            sub.includes("sponsor") ||
            desc.includes("reklam") ||
            desc.includes("platform") ||
            desc.includes("hizmet bedeli");
          if (!isAd) continue;
          out.push({
            ...r,
            description: r.description || "Platform hizmet bedeli",
          });
        }
      } catch {
        return [];
      }
    }

    return out;
  }

  private requireSeller(credentials: MarketplaceCredentials) {
    const sellerId = credentials.externalStoreId?.trim();
    if (!sellerId) {
      throw new MarketplacePullError(
        "Satıcı ID gerekli. Mağaza bağlantısında satıcı numarasını girin.",
      );
    }
    if (!credentials.apiKey?.trim() || !credentials.apiSecret?.trim()) {
      throw new MarketplacePullError(
        "Entegrasyon anahtarları eksik. Bağlantıyı yeniden kaydedin.",
      );
    }
    return sellerId;
  }

  private authHeaders(
    credentials: MarketplaceCredentials,
    sellerId: string,
  ): Record<string, string> {
    const integrator =
      process.env.TRENDYOL_INTEGRATOR_NAME?.trim() || "SelfIntegration";
    return {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${credentials.apiKey}:${credentials.apiSecret}`,
      ).toString("base64")}`,
      "User-Agent": `${sellerId} - ${integrator}`,
    };
  }

  private firstString(row: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const v = row[key];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return null;
  }

  private firstNumber(row: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const n = Number(row[key]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  private async fetchPages(opts: {
    baseUrl: string;
    path: string;
    headers: Record<string, string>;
    timeoutMs: number;
    pageSize: number;
    maxPages: number;
    query: Record<string, string>;
    label: string;
    allowEmpty?: boolean;
  }): Promise<{ content: unknown[] }> {
    const all: unknown[] = [];
    let page = 0;

    while (page < opts.maxPages) {
      const url = new URL(opts.path, `${opts.baseUrl}/`);
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v);
      }
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(opts.pageSize));

      const json = await this.getJson(url, opts.headers, opts.timeoutMs, opts.label);
      const content = Array.isArray(json.content) ? json.content : [];
      all.push(...content);

      if (content.length === 0) break;
      if (content.length < opts.pageSize) break;

      const totalPages = Number(json.totalPages);
      const totalElements = Number(json.totalElements);
      if (Number.isFinite(totalPages) && totalPages > 0 && page + 1 >= totalPages) {
        break;
      }
      if (
        Number.isFinite(totalElements) &&
        totalElements > 0 &&
        all.length >= totalElements
      ) {
        break;
      }

      page += 1;
    }

    if (all.length === 0 && !opts.allowEmpty) {
      throw new MarketplacePullError(
        `Pazaryerinden ${opts.label} listesi boş döndü.`,
      );
    }

    return { content: all };
  }

  private async getJson(
    url: URL,
    headers: Record<string, string>,
    timeoutMs: number,
    label: string,
  ): Promise<{
    content?: unknown[];
    totalPages?: number;
    totalElements?: number;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 401 || res.status === 403) {
        throw new MarketplacePullError(
          "Pazaryeri kimlik doğrulaması reddedildi. Anahtarları kontrol edin.",
        );
      }
      if (res.status === 429) {
        throw new MarketplacePullError(
          "Pazaryeri istek limiti aşıldı. Biraz sonra tekrar deneyin.",
        );
      }
      if (!res.ok) {
        throw new MarketplacePullError(
          `Pazaryeri ${label} uçuna ulaşılamadı. Daha sonra tekrar deneyin.`,
        );
      }
      return (await res.json()) as {
        content?: unknown[];
        totalPages?: number;
        totalElements?: number;
      };
    } catch (err) {
      if (err instanceof MarketplacePullError) throw err;
      throw new MarketplacePullError(
        `Pazaryeri ${label} çekimi tamamlanamadı. Bağlantıyı kontrol edin.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
