import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ImportPromoOffersDto } from "./dto";
import { PromotionsService } from "./promotions.service";

@ApiTags("promotions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("promotions")
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  overview(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("targetMargin") targetRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        offers: [],
        realized: [],
        source: "empty",
        note: "Organizasyon bulunamadı",
      };
    }
    const target = Math.max(0, Number(targetRaw) || 15);
    return this.promotions.overview(orgId, target);
  }

  @Get("realized")
  realized(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("targetMargin") targetRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        periodDays: 30,
        source: "empty",
        note: "Organizasyon bulunamadı",
        summary: {
          campaigns: 0,
          orders: 0,
          net: 0,
          worseThanEstimate: 0,
          fromOrders: 0,
        },
        rows: [],
      };
    }
    const target = Math.max(0, Number(targetRaw) || 15);
    return this.promotions.realized(orgId, target);
  }

  @Post("sync")
  sync(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("targetMargin") targetRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        ok: false,
        upserted: 0,
        message: "Organizasyon bulunamadı",
      };
    }
    const target = Math.max(0, Number(targetRaw) || 15);
    return this.promotions.sync(orgId, target);
  }

  @Post("import")
  importOffers(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: ImportPromoOffersDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        upserted: 0,
        missed: [],
        offers: [],
        message: "Organizasyon bulunamadı",
      };
    }
    return this.promotions.importOffers(orgId, dto);
  }
}
