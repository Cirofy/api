import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ApplyPricesDto } from "./dto";
import { PricingService, type PriceTargetMode } from "./pricing.service";

@ApiTags("pricing")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("pricing")
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  list(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("mode") modeRaw?: string,
    @Query("target") targetRaw?: string,
    @Query("tsfMarkup") tsfRaw?: string,
    @Query("usePlus") usePlusRaw?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        mode: "margin_pct",
        target: 15,
        tsfMarkupPct: 8,
        usePlus: false,
        count: 0,
        items: [],
      };
    }
    const mode = parseMode(modeRaw);
    const target = Math.max(
      0,
      Number(targetRaw) || (mode === "net_amount" ? 40 : 15),
    );
    const tsfMarkup = Math.max(0, Math.min(40, Number(tsfRaw) || 8));
    const usePlus =
      usePlusRaw === "1" ||
      usePlusRaw === "true" ||
      usePlusRaw === "yes";
    return this.pricing.listSuggestions(
      orgId,
      mode,
      target,
      tsfMarkup,
      usePlus,
    );
  }

  @Post("apply")
  apply(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: ApplyPricesDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { updated: 0, missed: [], message: "Organizasyon bulunamadı" };
    }
    return this.pricing.applyPrices(orgId, dto);
  }
}

function parseMode(raw?: string): PriceTargetMode {
  if (raw === "net_amount" || raw === "markup_pct" || raw === "margin_pct") {
    return raw;
  }
  return "margin_pct";
}
