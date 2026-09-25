import { Body, Controller, Get, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { EnqueueDigestDto, UpdateMailPrefsDto } from "./dto";
import { ReportsService } from "./reports.service";

@ApiTags("reports")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("plus-vs-standard")
  plusVsStandard(
    @Req() req: { user: { organization: { id: string } | null } },
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        items: [],
        summary: null,
        message: "Organizasyon bulunamadı",
      };
    }
    return this.reports.plusVsStandard(orgId);
  }

  @Get("category-profit")
  categoryProfit(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    const days = Number(daysRaw);
    if (!orgId) {
      return {
        days: [7, 30, 90].includes(days) ? days : 30,
        items: [],
        summary: null,
        message: "Organizasyon bulunamadı",
      };
    }
    return this.reports.categoryProfit(orgId, days);
  }

  @Get("mail-prefs")
  mailPrefs(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        email: "",
        daily: false,
        monthly: false,
        tariffChange: false,
        updatedAt: null,
      };
    }
    return this.reports.getMailPrefs(orgId);
  }

  @Put("mail-prefs")
  saveMailPrefs(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: UpdateMailPrefsDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        email: dto.email,
        daily: dto.daily,
        monthly: dto.monthly,
        tariffChange: Boolean(dto.tariffChange),
        updatedAt: null,
      };
    }
    return this.reports.saveMailPrefs(orgId, dto);
  }

  @Post("enqueue-digest")
  enqueue(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: EnqueueDigestDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        id: null,
        status: "skipped",
        note: "Organizasyon bulunamadı",
      };
    }
    return this.reports.enqueueDigest(orgId, dto);
  }

  @Get("jobs")
  async jobs(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { jobs: [] };
    return { jobs: await this.reports.listJobs(orgId) };
  }

  @Post("retry-failed")
  retryFailed(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { retried: 0, jobs: [], message: "Organizasyon bulunamadı" };
    }
    return this.reports.retryFailed(orgId);
  }

  @Post("digest-payload")
  digestPayload(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: EnqueueDigestDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        organizationId: null,
        cadence: dto.cadence,
        metrics: null,
        message: "Organizasyon bulunamadı",
      };
    }
    return this.reports.buildDigestPayload(orgId, dto.cadence);
  }
}
