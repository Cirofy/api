import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { UpdateSettlementIssueDto } from "./dto";
import { SettlementsService } from "./settlements.service";

@ApiTags("settlements")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("settlements")
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  overview(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("storeId") storeId?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        periods: [],
        issues: [],
        stores: [],
        storeId: null,
        storeName: "",
        source: "empty",
        note: "Organizasyon bulunamadı",
      };
    }
    return this.settlements.overview(orgId, storeId || undefined);
  }

  @Post("sync")
  sync(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        ok: false,
        periods: 0,
        issues: 0,
        message: "Organizasyon bulunamadı",
      };
    }
    return this.settlements.sync(orgId);
  }

  @Patch("issues/:id")
  updateIssue(
    @Req() req: { user: { organization: { id: string } | null } },
    @Param("id") id: string,
    @Body() dto: UpdateSettlementIssueDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { ok: false, message: "Organizasyon bulunamadı" };
    }
    return this.settlements.updateIssueStatus(orgId, id, dto.status);
  }
}
