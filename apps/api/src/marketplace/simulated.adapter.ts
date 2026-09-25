import { MarketplacePullError } from "./pull-error";
import type {
  MarketplaceAdapter,
  MarketplaceCode,
  MarketplaceCredentials,
  MarketplacePullResult,
} from "./marketplace.types";

/** Sahte çekim kapalı — ürün/sipariş uydurulmaz. */
export class SimulatedMarketplaceAdapter implements MarketplaceAdapter {
  constructor(readonly code: MarketplaceCode) {}

  async pull(
    _credentials: MarketplaceCredentials,
    _options?: { sinceDays?: number },
  ): Promise<MarketplacePullResult> {
    throw new MarketplacePullError(
      "Pazaryeri canlı çekimi gerekli. Mağaza anahtarlarını kontrol edip tekrar senkronlayın.",
    );
  }
}
