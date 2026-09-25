import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { QuotaService } from "../billing/quota.service";
import { ConnectStoreDto } from "./dto";
import { StoresService } from "./stores.service";
import { SyncJobsService } from "./sync-jobs.service";

type AuthUser = {
  organization: { id: string } | null;
};

@ApiTags("stores")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("stores")
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly syncJobs: SyncJobsService,
    private readonly quotas: QuotaService,
  ) {}

  @Get()
  list(@Req() req: { user: AuthUser }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return [];
    return this.stores.list(orgId);
  }

  @Get("sync-jobs")
  listJobs(@Req() req: { user: AuthUser }, @Query("limit") limit?: string) {
    const orgId = req.user.organization?.id;
    if (!orgId) return [];
    const n = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.syncJobs.list(orgId, n);
  }

  @Get("sync-jobs/:jobId")
  getJob(@Req() req: { user: AuthUser }, @Param("jobId") jobId: string) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { error: "Organizasyon yok" };
    return this.syncJobs.get(orgId, jobId);
  }

  @Post("connect")
  async connect(@Req() req: { user: AuthUser }, @Body() dto: ConnectStoreDto) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { error: "Organizasyon yok" };
    await this.quotas.assertCanConnectStore(orgId);
    return this.stores.connect(orgId, dto);
  }

  @Post(":id/validate")
  async validate(@Req() req: { user: AuthUser }, @Param("id") id: string) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { ok: false, message: "Organizasyon yok" };
    return this.stores.validateCredentials(orgId, id);
  }

  @Post(":id/sync")
  async startSync(
    @Req() req: { user: AuthUser },
    @Param("id") id: string,
    @Body() body?: { kind?: "marketplace_pull" },
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { error: "Organizasyon yok" };
    await this.quotas.assertCanSync(orgId);
    return this.syncJobs.enqueue(orgId, id, body?.kind ?? "marketplace_pull");
  }
}
