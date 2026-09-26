import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateSupportTicketDto } from "./dto";
import { SupportService } from "./support.service";

@ApiTags("support")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("support")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get("tickets")
  list(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { items: [], source: "empty" };
    return this.support.list(orgId);
  }

  @Post("tickets")
  create(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: CreateSupportTicketDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { item: null, message: "Organizasyon bulunamadı" };
    }
    return this.support.create(orgId, dto);
  }
}
