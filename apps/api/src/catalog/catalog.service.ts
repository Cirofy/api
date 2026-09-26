import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TariffsService } from "../tariffs/tariffs.service";
import type { AssignCategoryDto, CostRowDto } from "./dto";

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: TariffsService,
  ) {}

  /** Kategorisi boş ürünlere kategori (ve isteğe bağlı tarife komisyonu) ata. */
  async assignCategory(organizationId: string, dto: AssignCategoryDto) {
    const category = (dto.category?.trim() || "Diğer").slice(0, 120);
    const ids = dto.productIds?.filter(Boolean) ?? [];
    const products = await this.prisma.product.findMany({
      where: {
        organizationId,
        isActive: true,
        ...(ids.length ? { id: { in: ids } } : {}),
        OR: [{ category: null }, { category: "" }],
      },
      select: {
        id: true,
        sku: true,
        title: true,
        store: { select: { id: true, marketplace: true } },
      },
      take: 500,
    });

    let updated = 0;
    let tariffApplied = 0;
    for (const p of products) {
      let commissionRate: number | undefined;
      if (dto.applyTariff) {
        try {
          const resolved = await this.tariffs.resolveForProduct(
            organizationId,
            p.store.marketplace,
            category,
            p.store.id,
          );
          if (resolved) {
            commissionRate = dto.usePlus ? resolved.plusRate : resolved.rate;
            tariffApplied += 1;
          }
        } catch {
          // tarife yoksa yalnız kategori yazılır
        }
      }
      await this.prisma.product.update({
        where: { id: p.id },
        data: {
          category,
          ...(commissionRate != null ? { commissionRate } : {}),
        },
      });
      updated += 1;
    }

    return {
      updated,
      tariffApplied,
      category,
      scanned: products.length,
      message:
        updated > 0
          ? `${updated} ürüne «${category}» atandı${
              dto.applyTariff ? ` · ${tariffApplied} tarife uygulandı` : ""
            }.`
          : ids.length
            ? "Seçilenlerde kategori eksik ürün yok."
            : "Kategori eksik ürün yok.",
    };
  }

  async applyCostRows(organizationId: string, rows: CostRowDto[]) {
    let updated = 0;
    const missed: string[] = [];

    for (const row of rows) {
      const sku = row.sku?.trim();
      const barcode = row.barcode?.trim();
      if (!sku && !barcode) {
        if (
          row.costPrice != null ||
          row.costVatRate != null ||
          row.desi != null ||
          row.shippingCost != null
        ) {
          missed.push("(sku/barkod yok)");
        }
        continue;
      }

      const products = await this.prisma.product.findMany({
        where: {
          organizationId,
          OR: [
            ...(sku ? [{ sku }] : []),
            ...(barcode ? [{ barcode }] : []),
          ],
        },
        select: { id: true, sku: true },
        take: 20,
      });

      if (products.length === 0) {
        missed.push(sku || barcode || "(sku yok)");
        continue;
      }

      for (const p of products) {
        await this.prisma.product.update({
          where: { id: p.id },
          data: {
            ...(row.costPrice != null ? { costPrice: row.costPrice } : {}),
            ...(row.costVatRate != null ? { costVatRate: row.costVatRate } : {}),
            ...(row.desi != null ? { desi: row.desi } : {}),
            ...(row.shippingCost != null
              ? { shippingCost: row.shippingCost }
              : {}),
            ...(row.commissionRate != null
              ? { commissionRate: row.commissionRate }
              : {}),
          },
        });
        updated += 1;
      }
    }

    return {
      updated,
      missed: missed.slice(0, 20),
      message:
        updated > 0
          ? `${updated} ürün maliyeti güncellendi.`
          : "Eşleşen ürün bulunamadı.",
    };
  }
}
