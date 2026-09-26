import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdsService } from "./ads.service";

@ApiTags("ads")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("ads")
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  @Get("spend")
  async spend(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        organizationId: null,
        source: "empty",
        rows: [],
        note: "Organizasyon bulunamadı",
        validation: null,
      };
    }
    const days = Math.min(90, Math.max(1, Number(daysRaw) || 7));
    return this.ads.pullSpend(orgId, days);
  }

  @Post("pull")
  async pull(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        organizationId: null,
        source: "empty",
        rows: [],
        note: "Organizasyon bulunamadı",
        validation: null,
      };
    }
    const days = Math.min(90, Math.max(1, Number(daysRaw) || 7));
    return this.ads.pullSpend(orgId, days);
  }

  /** Ham partner JSON gövdesini şema eşleyiciye sokar — canlı uç öncesi doğrulama */
  @Post("validate")
  validate(
    @Body() body: unknown,
    @Query("marketplace") marketplace?: string,
  ) {
    return this.ads.validateSample(body ?? {}, marketplace);
  }
}
