import { Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AgencyService } from "./agency.service";

@ApiTags("agency")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("agency")
export class AgencyController {
  constructor(private readonly agency: AgencyService) {}

  @Get("portfolio")
  portfolio(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { items: [], source: "empty", note: "Organizasyon bulunamadı" };
    }
    return this.agency.portfolio(orgId);
  }

  @Get("tariff-sla")
  tariffSla(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        items: [],
        breachedCount: 0,
        watchCount: 0,
        okCount: 0,
        source: "empty",
        note: "Organizasyon bulunamadı",
      };
    }
    return this.agency.tariffSla(orgId);
  }

  @Post("tariff-sla/enqueue")
  enqueueTariffSla(
    @Req() req: { user: { organization: { id: string } | null } },
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        ok: false,
        status: "skipped",
        message: "Organizasyon bulunamadı",
      };
    }
    return this.agency.enqueueTariffSlaDigest(orgId);
  }
}
