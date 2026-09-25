import { Injectable } from "@nestjs/common";
import type { MarketplaceAdapter, MarketplaceCode } from "./marketplace.types";
import { HepsiburadaMarketplaceAdapter } from "./hepsiburada.adapter";
import { TrendyolMarketplaceAdapter } from "./trendyol.adapter";

@Injectable()
export class MarketplaceRegistry {
  private readonly adapters: Record<MarketplaceCode, MarketplaceAdapter>;

  constructor() {
    // Canlı adaptörler; sahte/simüle çekim yok.
    this.adapters = {
      TRENDYOL: new TrendyolMarketplaceAdapter(),
      HEPSIBURADA: new HepsiburadaMarketplaceAdapter(),
    };
  }

  get(code: MarketplaceCode): MarketplaceAdapter {
    return this.adapters[code];
  }

  isLiveEnabled() {
    return true;
  }
}
