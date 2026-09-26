import type { PulledCommissionRate } from "./commission-rates";
import { normalizeCommissionRate } from "./commission-rates";
import type {
  AccountingPullOptions,
  CommissionPullOptions,
  MarketplaceAdapter,
  MarketplaceCredentials,
  MarketplacePullResult,
  PulledAccountingRow,
  PulledSellerPromotion,
} from "./marketplace.types";
import { mapPartnerPayload } from "./partner-mappers";
import { MarketplacePullError } from "./pull-error";

const PRODUCT_PAGE_SIZE = 200;
const MAX_PRODUCT_PAGES = 15;
const ORDER_PAGE_SIZE = 200;
const MAX_ORDER_PAGES = 15;
const FINANCE_PAGE_SIZE = 200;
const MAX_FINANCE_PAGES = 20;

/**
 * Hepsiburada — ürün/sipariş (mpop + OMS) + komisyon (listing-external).
 */
export class HepsiburadaMarketplaceAdapter implements MarketplaceAdapter {
  readonly code = "HEPSIBURADA" as const;

  async pull(
    credentials: MarketplaceCredentials,
    options?: { sinceDays?: number },
  ): Promise<MarketplacePullResult> {
    const merchantId = this.requireMerchant(credentials);
    const headers = this.authHeaders(credentials, merchantId);
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);

    const mpopBase = (
      process.env.HEPSIBURADA_API_BASE?.trim() ||
      "https://mpop.hepsiburada.com"
    ).replace(/\/$/, "");
    const productsPath =
      process.env.HEPSIBURADA_PRODUCTS_PATH?.trim() ||
      "/product/api/products/all-products-of-merchant";

    const omsBase = (
      process.env.HEPSIBURADA_OMS_API_BASE?.trim() ||
      "https://oms-external.hepsiburada.com"
    ).replace(/\/$/, "");
    const ordersPath =
      process.env.HEPSIBURADA_ORDERS_PATH?.trim() ||
      "/orders/merchantId/{merchantId}";

    const sinceDays = options?.sinceDays ?? 7;
    const end = new Date();
    const start = new Date(end.getTime() - sinceDays * 86400_000);
    const beginDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const productsJson = await this.fetchProductPages({
      baseUrl: mpopBase,
      path: productsPath.replace("{merchantId}", merchantId),
      merchantId,
      headers,
      timeoutMs,
    });

    const ordersJson = await this.fetchOrderOffsetPages({
      baseUrl: omsBase,
      path: ordersPath.replace("{merchantId}", merchantId),
      merchantId,
      headers,
      timeoutMs,
      beginDate,
      endDate,
    });

    const mapped = mapPartnerPayload("HEPSIBURADA", productsJson, ordersJson);
    if (!mapped || mapped.products.length === 0) {
      throw new MarketplacePullError(
        "Pazaryerinden ürün alınamadı. Anahtarları ve satıcı ID’yi kontrol edin.",
      );
    }

    return {
      ...mapped,
      source: "live",
      note: `Hepsiburada canlı çekim: ${mapped.products.length} ürün, ${mapped.orders.length} sipariş satırı.`,
    };
  }

  async pullCommissionRates(
    credentials: MarketplaceCredentials,
    options?: CommissionPullOptions,
  ): Promise<PulledCommissionRate[]> {
    const merchantId = this.requireMerchant(credentials);
    if (!credentials.apiKey?.trim() || !credentials.apiSecret?.trim()) {
      throw new MarketplacePullError(
        "Entegrasyon anahtarları eksik. Bağlantıyı yeniden kaydedin.",
      );
    }

    const catalog = options?.catalog ?? [];
    const skus = [
      ...new Set(
        catalog
          .flatMap((p) => [p.sku, p.externalId, p.barcode])
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim()),
      ),
    ];
    if (skus.length === 0) {
      return [];
    }

    const listingBase = (
      process.env.HEPSIBURADA_LISTING_API_BASE?.trim() ||
      "https://listing-external.hepsiburada.com"
    ).replace(/\/$/, "");
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const headers = this.authHeaders(credentials, merchantId);

    const bySku = new Map<string, string>();
    for (const p of catalog) {
      const cat = (p.category || "Diğer").trim() || "Diğer";
      for (const key of [p.sku, p.externalId, p.barcode]) {
        if (key?.trim()) bySku.set(key.trim(), cat);
      }
    }

    const rows: PulledCommissionRate[] = [];
    const chunkSize = 40;
    for (let i = 0; i < skus.length; i += chunkSize) {
      const chunk = skus.slice(i, i + chunkSize);
      const url = new URL(
        `/commissions/merchantid/${encodeURIComponent(merchantId)}`,
        `${listingBase}/`,
      );
      url.searchParams.set("skuList", chunk.join(","));

      const data = await this.getJson(url, headers, timeoutMs, "komisyon");
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { items?: unknown[] })?.items)
          ? (data as { items: unknown[] }).items
          : [];

      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const rateRaw = Number(row.commissionRate);
        const rate = normalizeCommissionRate(rateRaw);
        if (rate == null) continue;
        const merchantSku =
          typeof row.merchantSku === "string" ? row.merchantSku.trim() : "";
        const hbSku =
          typeof row.hepsiburadaSku === "string"
            ? row.hepsiburadaSku.trim()
            : "";
        const category =
          (merchantSku && bySku.get(merchantSku)) ||
          (hbSku && bySku.get(hbSku)) ||
          "Diğer";
        rows.push({
          marketplace: "HEPSIBURADA",
          category,
          rate,
          plusRate: rate,
          sku: merchantSku || hbSku || null,
          note: "Hepsiburada listing · komisyon",
        });
      }
    }

    return rows;
  }

  async pullAccountingTransactions(
    credentials: MarketplaceCredentials,
    options: AccountingPullOptions,
  ): Promise<PulledAccountingRow[]> {
    const merchantId = this.requireMerchant(credentials);
    const headers = this.authHeaders(credentials, merchantId);
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const financeBase = (
      process.env.HEPSIBURADA_FINANCE_API_BASE?.trim() ||
      "https://mpfinance-external.hepsiburada.com"
    ).replace(/\/$/, "");

    const rows: PulledAccountingRow[] = [];
    let offset = 0;

    for (let page = 0; page < MAX_FINANCE_PAGES; page++) {
      const url = new URL(
        `/transactions/merchantid/${encodeURIComponent(merchantId)}`,
        `${financeBase}/`,
      );
      url.searchParams.set("Offset", String(offset));
      url.searchParams.set("Limit", String(FINANCE_PAGE_SIZE));
      url.searchParams.set("OrderDateStart", options.beginDate);
      url.searchParams.set("OrderDateEnd", options.endDate);

      const data = await this.getJson(url, headers, timeoutMs, "muhasebe");
      const list = this.extractList(data);
      if (list.length === 0) break;

      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const amount = this.firstNumber(row, [
          "amount",
          "totalAmount",
          "price",
          "value",
        ]);
        if (amount == null || amount === 0) continue;
        const typeName =
          this.firstString(row, [
            "transactionType",
            "type",
            "typeName",
            "description",
            "name",
          ]) ?? "İşlem";
        rows.push({
          typeName,
          orderId: this.firstString(row, [
            "orderNumber",
            "orderId",
            "orderNo",
            "packageNumber",
          ]),
          amount,
          transactionDate: this.firstString(row, [
            "orderDate",
            "transactionDate",
            "date",
            "createdDate",
          ]),
          description:
            this.firstString(row, ["description", "detail", "explanation"]) ??
            typeName,
        });
      }

      if (list.length < FINANCE_PAGE_SIZE) break;
      offset += list.length;
    }

    return rows;
  }

  async pullSellerPromotions(
    credentials: MarketplaceCredentials,
  ): Promise<PulledSellerPromotion[]> {
    const merchantId = this.requireMerchant(credentials);
    const headers = this.authHeaders(credentials, merchantId);
    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 20000);
    const promoBase = (
      process.env.HEPSIBURADA_PROMO_API_BASE?.trim() ||
      "https://diskonto-external.hepsiburada.com"
    ).replace(/\/$/, "");

    const url = new URL(
      `/self-campaign/${encodeURIComponent(merchantId)}/discounts`,
      `${promoBase}/`,
    );
    const data = await this.getJson(url, headers, timeoutMs, "kampanya");
    const list = this.extractList(data);
    const out: PulledSellerPromotion[] = [];

    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const rawType =
        this.firstString(row, ["campaignType", "type", "discountType"]) ?? null;
      const typeLower = (rawType ?? "").toLowerCase();
      const kind: "discount" | "flash" =
        typeLower.includes("flash") || typeLower.includes("flaş")
          ? "flash"
          : "discount";
      out.push({
        sku: this.firstString(row, [
          "merchantSku",
          "sku",
          "stockCode",
          "hepsiburadaSku",
        ]),
        title: this.firstString(row, ["title", "productName", "name"]),
        kind,
        listPrice: this.firstNumber(row, [
          "listPrice",
          "price",
          "originalPrice",
          "sellingPrice",
        ]),
        offerPrice: this.firstNumber(row, [
          "discountPrice",
          "offerPrice",
          "campaignPrice",
          "salePrice",
        ]),
        rawType,
      });
    }

    return out;
  }

  private requireMerchant(credentials: MarketplaceCredentials) {
    const merchantId = credentials.externalStoreId?.trim();
    if (!merchantId) {
      throw new MarketplacePullError(
        "Satıcı ID gerekli. Mağaza bağlantısında satıcı numarasını girin.",
      );
    }
    if (!credentials.apiKey?.trim() || !credentials.apiSecret?.trim()) {
      throw new MarketplacePullError(
        "Entegrasyon anahtarları eksik. Bağlantıyı yeniden kaydedin.",
      );
    }
    return merchantId;
  }

  private async fetchProductPages(opts: {
    baseUrl: string;
    path: string;
    merchantId: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }) {
    const all: unknown[] = [];
    for (let page = 0; page < MAX_PRODUCT_PAGES; page++) {
      const url = new URL(opts.path, `${opts.baseUrl}/`);
      url.searchParams.set("merchantId", opts.merchantId);
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(PRODUCT_PAGE_SIZE));

      const data = await this.getJson(url, opts.headers, opts.timeoutMs, "ürün");
      const list = this.extractList(data);
      all.push(...list);
      if (list.length === 0 || list.length < PRODUCT_PAGE_SIZE) break;
    }
    return { content: all };
  }

  private async fetchOrderOffsetPages(opts: {
    baseUrl: string;
    path: string;
    merchantId: string;
    headers: Record<string, string>;
    timeoutMs: number;
    beginDate: string;
    endDate: string;
  }) {
    const all: unknown[] = [];
    let offset = 0;

    for (let page = 0; page < MAX_ORDER_PAGES; page++) {
      const url = new URL(opts.path, `${opts.baseUrl}/`);
      url.searchParams.set("beginDate", opts.beginDate);
      url.searchParams.set("endDate", opts.endDate);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(ORDER_PAGE_SIZE));

      const data = await this.getJson(url, opts.headers, opts.timeoutMs, "sipariş");
      const list = this.extractList(data);
      all.push(...list);
      if (list.length === 0 || list.length < ORDER_PAGE_SIZE) break;
      offset += list.length;
    }

    return { content: all, items: all, orders: all };
  }

  private extractList(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.filter(
        (x): x is Record<string, unknown> => x != null && typeof x === "object",
      );
    }
    if (!data || typeof data !== "object") return [];
    const obj = data as Record<string, unknown>;
    for (const key of [
      "content",
      "items",
      "data",
      "result",
      "orders",
      "products",
      "discounts",
    ]) {
      const nested = obj[key];
      if (Array.isArray(nested)) {
        return nested.filter(
          (x): x is Record<string, unknown> =>
            x != null && typeof x === "object",
        );
      }
    }
    return [];
  }

  private firstString(row: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const v = row[key];
      if (typeof v === "string" && v.trim()) return v.trim();
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

  private authHeaders(
    credentials: MarketplaceCredentials,
    merchantId: string,
  ): Record<string, string> {
    const integrator =
      process.env.HEPSIBURADA_USER_AGENT?.trim() || "cirofy_integration";
    return {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${credentials.apiKey}:${credentials.apiSecret}`,
      ).toString("base64")}`,
      "User-Agent": integrator.includes(merchantId)
        ? integrator
        : `${merchantId} - ${integrator}`,
      merchantId,
      merchantid: merchantId,
    };
  }

  private async getJson(
    url: URL,
    headers: Record<string, string>,
    timeoutMs: number,
    label: string,
  ): Promise<unknown> {
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
      return await res.json();
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
