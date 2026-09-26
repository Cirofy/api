import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReturnsService } from "./returns.service";

@ApiTags("returns")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("returns")
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get("analysis")
  analysis(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("days") daysRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        periodDays: 30,
        hasData: false,
        summary: {
          returnCount: 0,
          orderCount: 0,
          returnRatePct: 0,
          netLoss: 0,
          grossReturned: 0,
          returnFees: 0,
          avgLossPerReturn: 0,
        },
        bySku: [],
        byCategory: [],
        byMarketplace: [],
        recent: [],
        note: "Organizasyon bulunamadı",
      };
    }
    const days = [7, 30, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 30;
    return this.returns.analysis(orgId, days);
  }
}
