import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decryptCredential } from "../marketplace/credential-crypto";
import { MarketplaceRegistry } from "../marketplace/marketplace.registry";
import type { MarketplaceCode } from "../marketplace/marketplace.types";
import {
  mapAndValidatePartnerAds,
  type PartnerAdsValidation,
} from "../marketplace/partner-ads-mappers";
import { PrismaService } from "../prisma/prisma.service";

export type AdSpendRow = {
  sku: string;
  title: string;
  marketplace: MarketplaceCode;
  adSpend: number;
  attributedSales: number;
  orders: number;
  influencerFee: number;
  netAfterAds: number;
  source: "empty" | "live";
};

/** Partner reklam harcama çekimi */
@Injectable()
export class AdsService {
  private readonly logger = new Logger(AdsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly marketplaces: MarketplaceRegistry,
  ) {}

  async pullSpend(
    organizationId: string,
    sinceDays = 7,
  ): Promise<{
    organizationId: string;
    sinceDays: number;
    source: "empty" | "live";
    note: string;
    rows: AdSpendRow[];
    validation: PartnerAdsValidation | null;
    pulledAt: string;
  }> {
    this.logger.log(`Ad spend pull org=${organizationId} days=${sinceDays}`);

    const override = await this.tryLivePull();
    if (override) {
      return {
        organizationId,
        sinceDays,
        source: "live",
        note: override.validation.ok
          ? `${override.validation.mappedCount} reklam satırı eşlendi (özel kaynak).`
          : `Eşleme kısmi: ${override.validation.mappedCount}/${override.validation.rowCount} satır.`,
        rows: override.rows.map((r) => ({ ...r, source: "live" as const })),
        validation: override.validation,
        pulledAt: new Date().toISOString(),
      };
    }

    const windowDays = Math.min(14, Math.max(1, sinceDays));
    const liveRows = await this.pullFromStores(organizationId, windowDays);

    if (liveRows.length > 0) {
      return {
        organizationId,
        sinceDays: windowDays,
        source: "live",
        note: `${liveRows.length} reklam / platform hizmet satırı pazaryerinden alındı.`,
        rows: liveRows.map((r) => ({ ...r, source: "live" as const })),
        validation: null,
        pulledAt: new Date().toISOString(),
      };
    }

    return {
      organizationId,
      sinceDays: windowDays,
      source: "empty",
      note: "Reklam verisi yok veya uçlar henüz satır döndürmedi.",
      rows: [],
      validation: null,
      pulledAt: new Date().toISOString(),
    };
  }

  /** Ham JSON’u şema eşleyiciye sokup doğrulama özeti döner (canlı uç testi). */
  validateSample(
    json: unknown,
    marketplace?: string,
  ): {
    source: "validation";
    note: string;
    rows: AdSpendRow[];
    validation: PartnerAdsValidation;
  } {
    const code = (
      marketplace ?? this.config.get<string>("ADS_MARKETPLACE") ?? "TRENDYOL"
    ).toUpperCase() as MarketplaceCode;
    const result = mapAndValidatePartnerAds(
      code === "HEPSIBURADA" ? "HEPSIBURADA" : "TRENDYOL",
      json,
    );
    return {
      source: "validation",
      note: result.validation.ok
        ? "Şema doğrulandı."
        : result.validation.issues[0] ?? "Şema eşlenemedi.",
      rows: result.rows.map((r) => ({ ...r, source: "live" as const })),
      validation: result.validation,
    };
  }

  private async pullFromStores(organizationId: string, sinceDays: number) {
    const stores = await this.prisma.store.findMany({
      where: { organizationId },
      select: {
        marketplace: true,
        externalStoreId: true,
        apiKeyEncrypted: true,
        apiSecretEncrypted: true,
      },
    });

    const aggregated = new Map<
      string,
      Omit<AdSpendRow, "source"> & { source?: never }
    >();

    const end = new Date();
    const start = new Date(end.getTime() - sinceDays * 86400_000);
    const beginDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    for (const store of stores) {
      if (
        store.marketplace !== "TRENDYOL" &&
        store.marketplace !== "HEPSIBURADA"
      ) {
        continue;
      }
      const apiKey = decryptCredential(store.apiKeyEncrypted);
      const apiSecret = decryptCredential(store.apiSecretEncrypted);
      if (!apiKey || !apiSecret || !store.externalStoreId?.trim()) continue;

      const creds = {
        apiKey,
        apiSecret,
        externalStoreId: store.externalStoreId,
      };
      const code = store.marketplace as MarketplaceCode;
      const adapter = this.marketplaces.get(code);

      try {
        if (code === "TRENDYOL" && adapter.pullAdsFees) {
          const fees = await adapter.pullAdsFees(creds, sinceDays);
          for (const fee of fees) {
            const sku = "PLATFORM";
            const key = `${code}::${sku}`;
            const cur = aggregated.get(key) ?? {
              sku,
              title: "Platform hizmet bedeli",
              marketplace: code,
              adSpend: 0,
              attributedSales: 0,
              orders: 0,
              influencerFee: 0,
              netAfterAds: 0,
            };
            cur.adSpend += fee.amount;
            cur.netAfterAds -= fee.amount;
            aggregated.set(key, cur);
          }
        }

        if (code === "HEPSIBURADA" && adapter.pullAccountingTransactions) {
          const tx = await adapter.pullAccountingTransactions(creds, {
            beginDate,
            endDate,
          });
          for (const row of tx) {
            const typeLower = row.typeName.toLowerCase();
            const descLower = (row.description ?? "").toLowerCase();
            const isAd =
              typeLower.includes("reklam") ||
              typeLower.includes("ads") ||
              typeLower.includes("service fee") ||
              descLower.includes("reklam") ||
              descLower.includes("hizmet bedeli");
            if (!isAd) continue;
            const sku = "PLATFORM";
            const key = `${code}::${sku}`;
            const cur = aggregated.get(key) ?? {
              sku,
              title: row.description || "Platform hizmet bedeli",
              marketplace: code,
              adSpend: 0,
              attributedSales: 0,
              orders: 0,
              influencerFee: 0,
              netAfterAds: 0,
            };
            const amt = Math.abs(row.amount);
            cur.adSpend += amt;
            cur.netAfterAds -= amt;
            aggregated.set(key, cur);
          }
        }
      } catch (err) {
        this.logger.warn(
          `Ads pull failed marketplace=${code}: ${(err as Error).message}`,
        );
      }
    }

    return [...aggregated.values()];
  }

  /** ADS_LIVE_PULL=1 ve ADS_SAMPLE_JSON (veya URL) ile partner şema testi */
  private async tryLivePull(): Promise<{
    rows: Omit<AdSpendRow, "source">[];
    validation: PartnerAdsValidation;
  } | null> {
    const enabled = this.config.get<string>("ADS_LIVE_PULL");
    if (enabled !== "1" && enabled !== "true") return null;

    const sample = this.config.get<string>("ADS_SAMPLE_JSON");
    const url = this.config.get<string>("ADS_PULL_URL");
    const code = (
      this.config.get<string>("ADS_MARKETPLACE") ?? "TRENDYOL"
    ).toUpperCase() as MarketplaceCode;

    let json: unknown = null;
    if (sample) {
      try {
        json = JSON.parse(sample);
      } catch {
        this.logger.warn("ADS_SAMPLE_JSON parse failed");
        return null;
      }
    } else if (url) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return null;
        json = await res.json();
      } catch (err) {
        this.logger.warn(`ADS_PULL_URL failed: ${(err as Error).message}`);
        return null;
      }
    } else {
      return null;
    }

    const result = mapAndValidatePartnerAds(
      code === "HEPSIBURADA" ? "HEPSIBURADA" : "TRENDYOL",
      json,
    );
    if (result.rows.length === 0) return null;
    return { rows: result.rows, validation: result.validation };
  }
}
