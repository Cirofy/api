import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { BuyboxService } from "./buybox.service";
import { CaptureBuyboxDto } from "./dto";

@ApiTags("buybox")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("buybox")
export class BuyboxController {
  constructor(private readonly buybox: BuyboxService) {}

  @Get()
  list(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { items: [], captures: [], source: "empty", note: "Organizasyon bulunamadı" };
    }
    return this.buybox.list(orgId);
  }

  @Get("captures")
  listCaptures(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { items: [], source: "empty" };
    }
    return this.buybox.listCaptures(orgId);
  }

  @Post("captures")
  capture(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: CaptureBuyboxDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { item: null, message: "Organizasyon bulunamadı" };
    }
    return this.buybox.capture(orgId, dto);
  }
}
