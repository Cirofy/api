import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from "class-validator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ScenariosService } from "./scenarios.service";

export class SimulateScenarioDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  commissionDeltaPts?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  shippingDelta?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  flashDiscountPct?: number;
}

export class SaveScenarioDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiProperty()
  @IsNumber()
  commissionDeltaPts!: number;

  @ApiProperty()
  @IsNumber()
  shippingDelta!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  flashDiscountPct!: number;
}

export class CompareScenariosDto {
  @ApiProperty()
  @IsString()
  leftId!: string;

  @ApiProperty()
  @IsString()
  rightId!: string;
}

@ApiTags("scenarios")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("scenarios")
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Post("simulate")
  simulate(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: SimulateScenarioDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { error: "Organizasyon bulunamadı" };
    }
    return this.scenarios.simulate(orgId, dto);
  }

  @Post("catalog")
  catalog(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: Omit<SimulateScenarioDto, "productId">,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { items: [], totalDelta: 0 };
    }
    return this.scenarios.catalogImpact(orgId, dto);
  }

  @Get("saved")
  listSaved(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { items: [] };
    return this.scenarios.listSaved(orgId).then((items) => ({ items }));
  }

  @Post("saved")
  save(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: SaveScenarioDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { error: "Organizasyon bulunamadı" };
    }
    return this.scenarios.save(orgId, dto);
  }

  @Delete("saved/:id")
  remove(
    @Req() req: { user: { organization: { id: string } | null } },
    @Param("id") id: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { ok: false };
    return this.scenarios.remove(orgId, id);
  }

  @Post("compare")
  compare(
    @Req() req: { user: { organization: { id: string } | null } },
    @Body() dto: CompareScenariosDto,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return { error: "Organizasyon bulunamadı" };
    }
    return this.scenarios.compare(orgId, dto.leftId, dto.rightId);
  }

  @Get("comparisons")
  listComparisons(
    @Req() req: { user: { organization: { id: string } | null } },
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { items: [] };
    return this.scenarios
      .listComparisons(orgId)
      .then((items) => ({ items }));
  }

  @Delete("comparisons/:id")
  removeComparison(
    @Req() req: { user: { organization: { id: string } | null } },
    @Param("id") id: string,
  ) {
    const orgId = req.user.organization?.id;
    if (!orgId) return { ok: false };
    return this.scenarios.removeComparison(orgId, id);
  }
}
