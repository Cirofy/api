import {
  Body,
  Controller,
  Delete,
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
import { AcceptInviteDto, InviteMemberDto, UpdateMemberRoleDto } from "./dto";
import { TeamService } from "./team.service";

@ApiTags("team")
@Controller("team")
export class TeamController {
  constructor(private readonly team: TeamService) {}

  /** Davet önizleme — kimlik doğrulama yok (kayıt formu için). */
  @Get("invites/peek")
  peek(@Query("token") token?: string) {
    if (!token) return { valid: false, message: "Davet kodu gerekli" };
    return this.team.peekInvite(token);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  list(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { members: [], counts: { active: 0, pending: 0 }, source: "empty" };
    }
    return this.team.list(orgId);
  }

  @Post("invite")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  invite(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: InviteMemberDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.team.invite(orgId, dto);
  }

  @Post("invites/accept")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  accept(
    @Req()
    req: {
      user: {
        id: string;
        email: string;
        organization: { id: string } | null;
      };
    },
    @Body() dto: AcceptInviteDto,
  ) {
    return this.team.acceptInvite(req.user.id, req.user.email, dto.token);
  }

  @Patch(":id/role")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  updateRole(
    @Req() req: { user: { organization: { id: string } | null } },
    @Param("id") id: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.team.updateRole(orgId, id, dto);
  }

  @Delete(":id")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  remove(
    @Req() req: { user: { organization: { id: string } | null } },
    @Param("id") id: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.team.remove(orgId, id);
  }
}
