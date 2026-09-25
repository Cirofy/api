import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { NotificationsService } from "./notifications.service";

@ApiTags("notifications")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { items: [], unread: 0 };
    return this.notifications.list(orgId).then((items) => ({
      items,
      unread: items.filter((i) => !i.readAt && i.tone !== "profit").length,
    }));
  }

  @Post("scan")
  scan(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { emitted: 0 };
    return this.notifications.scanOrganization(orgId);
  }

  @Post("read-all")
  markAll(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { updated: 0 };
    return this.notifications.markAllRead(orgId);
  }

  @Post(":id/read")
  markRead(
    @Req() req: { user: { organization: { id: string } | null } },
    @Param("id") id: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { id, readAt: null };
    return this.notifications.markRead(orgId, id);
  }
}
