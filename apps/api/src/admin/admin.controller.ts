import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdminService } from "./admin.service";

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("overview")
  overview(@Req() req: { user: { role: string } }) {
    this.admin.assertAdmin(req.user.role);
    return this.admin.overview();
  }

  @Get("users")
  users(@Req() req: { user: { role: string } }) {
    this.admin.assertAdmin(req.user.role);
    return this.admin.listUsers();
  }

  @Get("stores")
  stores(@Req() req: { user: { role: string } }) {
    this.admin.assertAdmin(req.user.role);
    return this.admin.listStores();
  }

  @Get("tickets")
  tickets(@Req() req: { user: { role: string } }) {
    this.admin.assertAdmin(req.user.role);
    return this.admin.listTickets();
  }

  @Get("organizations/:id")
  async organization(
    @Req() req: { user: { role: string } },
    @Param("id") id: string,
  ) {
    this.admin.assertAdmin(req.user.role);
    const row = await this.admin.orgHealth(id);
    if (!row) throw new NotFoundException("Organizasyon bulunamadı");
    return row;
  }
}
