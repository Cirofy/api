import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogService } from "./catalog.service";
import { AssignCategoryDto, UpdateCostsDto } from "./dto";

@ApiTags("catalog")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  @Get("products")
  async products(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("limit") limitRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return [];
    const take = Math.min(
      Math.max(1, Number(limitRaw) || 5000),
      10000,
    );
    const rows = await this.prisma.product.findMany({
      where: { organizationId: orgId },
      orderBy: { updatedAt: "desc" },
      take,
      select: {
        id: true,
        title: true,
        sku: true,
        barcode: true,
        brand: true,
        category: true,
        returnRatePct: true,
        stockQty: true,
        costPrice: true,
        costVatRate: true,
        desi: true,
        salePrice: true,
        commissionRate: true,
        shippingCost: true,
        isActive: true,
        storeId: true,
        store: { select: { id: true, name: true, marketplace: true } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      title: p.title,
      sku: p.sku,
      barcode: p.barcode,
      brand: p.brand,
      category: p.category,
      returnRatePct: Number(p.returnRatePct),
      stockQty: p.stockQty,
      costPrice: Number(p.costPrice),
      costVatRate: Number(p.costVatRate),
      desi: Number(p.desi),
      salePrice: Number(p.salePrice),
      commissionRate: Number(p.commissionRate),
      shippingCost: Number(p.shippingCost),
      isActive: p.isActive,
      storeId: p.storeId,
      store: p.store
        ? {
            id: p.store.id,
            name: p.store.name,
            marketplace:
              p.store.marketplace === "HEPSIBURADA"
                ? "Hepsiburada"
                : "Trendyol",
          }
        : null,
      needsCategory: !p.category?.trim(),
    }));
  }

  /** XML/CSV parse sonrası satırları canlı ürüne uygula */
  @Post("products/costs")
  async updateCosts(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: UpdateCostsDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { updated: 0, missed: [], message: "Organizasyon bulunamadı" };
    }
    return this.catalog.applyCostRows(orgId, dto.rows ?? []);
  }

  /** Kategori eksik ürünlere kategori (+ isteğe bağlı tarife) ata */
  @Post("products/assign-category")
  async assignCategory(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: AssignCategoryDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        updated: 0,
        tariffApplied: 0,
        category: dto.category ?? "Diğer",
        scanned: 0,
        message: "Organizasyon bulunamadı",
      };
    }
    return this.catalog.assignCategory(orgId, dto);
  }

  @Get("orders")
  async orders(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("limit") limit?: string,
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return [];
    const take = Math.min(Number(limit) || 500, 5000);
    const days = [7, 30, 90].includes(Number(daysRaw))
      ? Number(daysRaw)
      : undefined;
    const where: {
      organizationId: string;
      orderedAt?: { gte: Date };
    } = { organizationId: orgId };
    if (days) {
      where.orderedAt = { gte: new Date(Date.now() - days * 86400_000) };
    }
    const rows = await this.prisma.order.findMany({
      where,
      orderBy: { orderedAt: "desc" },
      take,
      select: {
        id: true,
        externalId: true,
        status: true,
        orderedAt: true,
        grossAmount: true,
        commission: true,
        shippingFee: true,
        serviceFee: true,
        vatNet: true,
        withholding: true,
        costTotal: true,
        netProfit: true,
        store: { select: { name: true, marketplace: true } },
        items: {
          take: 1,
          select: {
            productId: true,
            product: {
              select: { id: true, title: true, sku: true, category: true },
            },
          },
        },
      },
    });

    return rows.map((o) => {
      const marketplace =
        o.store.marketplace === "HEPSIBURADA" ? "Hepsiburada" : "Trendyol";
      const item = o.items[0];
      const productTitle =
        item?.product?.title ?? item?.product?.sku ?? "Ürün";
      return {
        id: o.id,
        externalId: o.externalId,
        product: productTitle,
        productId: item?.productId ?? item?.product?.id ?? null,
        sku: item?.product?.sku ?? null,
        category: item?.product?.category ?? null,
        marketplace,
        status: o.status,
        orderedAt: o.orderedAt.toISOString(),
        grossAmount: Number(o.grossAmount),
        commission: Number(o.commission),
        shippingFee: Number(o.shippingFee),
        serviceFee: Number(o.serviceFee),
        vatNet: Number(o.vatNet),
        withholding: Number(o.withholding),
        costTotal: Number(o.costTotal),
        returnFee: o.status === "RETURNED" ? 25 : 0,
        netProfit: Number(o.netProfit),
        storeName: o.store.name,
      };
    });
  }
}
