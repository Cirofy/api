import type {
  MarketplaceAdapter,
  MarketplaceCode,
  MarketplaceCredentials,
  MarketplacePullResult,
} from "./marketplace.types";
import { mapPartnerPayload } from "./partner-mappers";
import { MarketplacePullError } from "./pull-error";

type HttpPullPaths = {
  productsPath: string;
  ordersPath: string;
};

/**
 * Canlı HTTP çekimi — başarısız yanıtta sahte veriye düşmez.
 */
export class HttpMarketplaceAdapter implements MarketplaceAdapter {
  constructor(
    readonly code: MarketplaceCode,
    private readonly baseUrl: string,
    private readonly paths: HttpPullPaths,
  ) {}

  async pull(
    credentials: MarketplaceCredentials,
    options?: { sinceDays?: number },
  ): Promise<MarketplacePullResult> {
    if (!this.baseUrl || !credentials.apiKey) {
      throw new MarketplacePullError(
        "Pazaryeri adresi veya API anahtarı eksik. Bağlantıyı yeniden kaydedin.",
      );
    }

    const timeoutMs = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS ?? 12000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`).toString("base64")}`,
      };
      if (credentials.externalStoreId) {
        headers["X-Store-Id"] = credentials.externalStoreId;
      }

      const productsUrl = new URL(this.paths.productsPath, this.baseUrl);
      const ordersUrl = new URL(this.paths.ordersPath, this.baseUrl);
      const sinceDays = options?.sinceDays ?? 7;
      const since = new Date(Date.now() - sinceDays * 86400_000)
        .toISOString()
        .slice(0, 10);
      ordersUrl.searchParams.set("sinceDays", String(sinceDays));
      ordersUrl.searchParams.set("startDate", since);
      ordersUrl.searchParams.set("endDate", new Date().toISOString().slice(0, 10));
      productsUrl.searchParams.set("pageSize", "200");

      const [productsRes, ordersRes] = await Promise.all([
        fetch(productsUrl, { headers, signal: controller.signal }),
        fetch(ordersUrl, { headers, signal: controller.signal }),
      ]);

      if (!productsRes.ok || !ordersRes.ok) {
        throw new MarketplacePullError(
          "Pazaryeri yanıt vermedi. Anahtarları ve satıcı bilgisini kontrol edin.",
        );
      }

      const productsJson = (await productsRes.json()) as unknown;
      const ordersJson = (await ordersRes.json()) as unknown;
      const mapped = mapPartnerPayload(this.code, productsJson, ordersJson);
      if (!mapped) {
        throw new MarketplacePullError(
          "Pazaryeri yanıtı okunamadı. Daha sonra tekrar deneyin.",
        );
      }

      return {
        ...mapped,
        source: "live",
        note: "Pazaryeri canlı çekimi tamamlandı",
      };
    } catch (err) {
      if (err instanceof MarketplacePullError) throw err;
      throw new MarketplacePullError(
        "Pazaryeri erişilemedi. Bağlantıyı kontrol edip tekrar deneyin.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
