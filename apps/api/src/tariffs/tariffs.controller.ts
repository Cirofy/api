import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsUUID, IsArray } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PLAN_QUOTAS, type PlanKey } from "../billing/plan-quotas";
import { PrismaService } from "../prisma/prisma.service";
import {
  ApplyTariffDto,
  ImportTariffsDto,
  UpsertTariffDto,
  UpsertTariffOverrideDto,
} from "./dto";
import { TariffsService, type TariffAuditCtx } from "./tariffs.service";

class ApplyProductTariffDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  usePlus?: boolean;
}

class ApplyMismatchesDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  productIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  usePlus?: boolean;

  @ApiPropertyOptional({
    description: "Yalnız mağaza override sapmalarını uygula",
  })
  @IsOptional()
  @IsBoolean()
  onlyOverrides?: boolean;
}

class ApplyOverrideDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  usePlus?: boolean;
}

type AuthedReq = {
  user: {
    id: string;
    organization: { id: string } | null;
  };
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function auditCtx(req: AuthedReq): TariffAuditCtx {
  const fwd = req.headers?.["x-forwarded-for"];
  const ip =
    typeof fwd === "string"
      ? fwd.split(",")[0]?.trim()
      : Array.isArray(fwd)
        ? String(fwd[0] ?? "")
        : req.ip ?? null;
  return { userId: req.user.id, ip: ip || null };
}

@ApiTags("tariffs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("tariffs")
export class TariffsController {
  constructor(
    private readonly tariffs: TariffsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Req() req: AuthedReq) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { items: [], productCategories: [], source: "empty" };
    }
    return this.tariffs.list(orgId);
  }

  @Get("history")
  history(@Req() req: AuthedReq, @Query("take") take?: string) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { items: [], total: 0, message: "Organizasyon bulunamadı" };
    const n = take ? Number(take) : 40;
    return this.tariffs.listHistory(orgId, Number.isFinite(n) ? n : 40);
  }

  @Get("resolve")
  resolve(
    @Req() req: AuthedReq,
    @Query("productId") productId?: string,
    @Query("sku") sku?: string,
    @Query("marketplace") marketplace?: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { tariff: null, message: "Organizasyon bulunamadı" };
    if (productId) return this.tariffs.resolveByProductId(orgId, productId);
    if (sku) return this.tariffs.resolveBySku(orgId, sku, marketplace);
    return { tariff: null, message: "productId veya sku gerekli" };
  }

  @Get("mismatches")
  async mismatches(@Req() req: AuthedReq) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { items: [], total: 0, message: "Organizasyon bulunamadı" };
    }
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { planId: true },
    });
    const planId = (sub?.planId ?? "STARTER") as PlanKey;
    const scanCap =
      (PLAN_QUOTAS[planId] ?? PLAN_QUOTAS.STARTER).tariffScanLimit;
    return this.tariffs.listMismatches(orgId, scanCap);
  }

  @Put()
  upsert(@Req() req: AuthedReq, @Body() dto: UpsertTariffDto) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.tariffs.upsert(orgId, dto, auditCtx(req));
  }

  @Post("import")
  importRows(@Req() req: AuthedReq, @Body() dto: ImportTariffsDto) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { upserted: 0, message: "Organizasyon bulunamadı" };
    return this.tariffs.importRows(orgId, dto, auditCtx(req));
  }

  @Post("sync")
  sync(@Req() req: AuthedReq) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        upserted: 0,
        markets: [],
        items: [],
        message: "Organizasyon bulunamadı",
      };
    }
    return this.tariffs.syncFromMarketplace(orgId, auditCtx(req));
  }

  @Put("overrides")
  upsertOverride(
    @Req() req: AuthedReq,
    @Body() dto: UpsertTariffOverrideDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.tariffs.upsertOverride(orgId, dto, auditCtx(req));
  }

  @Delete("overrides/:id")
  removeOverride(@Req() req: AuthedReq, @Param("id") id: string) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.tariffs.removeOverride(orgId, id, auditCtx(req));
  }

  @Post("apply")
  apply(@Req() req: AuthedReq, @Body() dto: ApplyTariffDto) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { updated: 0, message: "Organizasyon bulunamadı" };
    return this.tariffs.apply(orgId, dto, auditCtx(req));
  }

  @Post("apply-product")
  applyProduct(@Req() req: AuthedReq, @Body() dto: ApplyProductTariffDto) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { updated: 0, message: "Organizasyon bulunamadı" };
    return this.tariffs.applyToProduct(
      orgId,
      dto.productId,
      Boolean(dto.usePlus),
      auditCtx(req),
    );
  }

  @Post("apply-mismatches")
  async applyMismatches(
    @Req() req: AuthedReq,
    @Body() dto: ApplyMismatchesDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { updated: 0, message: "Organizasyon bulunamadı" };
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { planId: true },
    });
    const planId = (sub?.planId ?? "STARTER") as PlanKey;
    const scanCap =
      (PLAN_QUOTAS[planId] ?? PLAN_QUOTAS.STARTER).tariffScanLimit;
    return this.tariffs.applyMismatches(
      orgId,
      dto.productIds,
      Boolean(dto.usePlus),
      scanCap,
      auditCtx(req),
      Boolean(dto.onlyOverrides),
    );
  }

  @Post("apply-override")
  applyOverride(@Req() req: AuthedReq, @Body() dto: ApplyOverrideDto) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { updated: 0, message: "Organizasyon bulunamadı" };
    return this.tariffs.applyOverride(
      orgId,
      dto.id,
      Boolean(dto.usePlus),
      auditCtx(req),
    );
  }

  @Delete(":id")
  remove(@Req() req: AuthedReq, @Param("id") id: string) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { message: "Organizasyon bulunamadı" };
    return this.tariffs.remove(orgId, id, auditCtx(req));
  }
}
