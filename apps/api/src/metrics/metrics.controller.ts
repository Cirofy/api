import { Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { MetricsService } from "./metrics.service";

@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Post("daily-run")
  async dailyRun(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("day") day?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { day: null, stores: 0, message: "Organizasyon bulunamadı" };
    }
    const target = day ? new Date(`${day}T00:00:00.000Z`) : undefined;
    if (target && Number.isNaN(target.getTime())) {
      return { day: null, stores: 0, message: "Geçersiz gün" };
    }
    return this.metrics.runDailySnapshot(target, orgId);
  }

  @Get("daily")
  async daily(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { rows: [] };
    const days = Math.min(30, Math.max(1, Number(daysRaw) || 7));
    const rows = await this.metrics.listRecent(orgId, days);
    return { rows };
  }
}
