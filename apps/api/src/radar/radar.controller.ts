import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { UpdateRadarPrefsDto } from "./dto";
import { RadarService } from "./radar.service";

@ApiTags("radar")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("radar")
export class RadarController {
  constructor(private readonly radar: RadarService) {}

  @Get()
  overview(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        trackedStores: [],
        trackedProducts: [],
        ads: [],
        influencers: [],
        alertCount: 0,
        prefs: {
          priceDropPctThreshold: 3,
          stockAlertEnabled: true,
          updatedAt: null,
        },
        source: "empty",
        note: "Organizasyon bulunamadı",
      };
    }
    return this.radar.overview(orgId);
  }

  @Get("prefs")
  prefs(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        priceDropPctThreshold: 3,
        stockAlertEnabled: true,
        updatedAt: null,
      };
    }
    return this.radar.getPrefs(orgId);
  }

  @Put("prefs")
  savePrefs(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: UpdateRadarPrefsDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        priceDropPctThreshold: dto.priceDropPctThreshold,
        stockAlertEnabled: dto.stockAlertEnabled,
        updatedAt: null,
      };
    }
    return this.radar.savePrefs(orgId, dto);
  }
}
