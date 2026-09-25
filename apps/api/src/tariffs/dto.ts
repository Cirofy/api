import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpsertTariffDto {
  @ApiProperty({ enum: ["TRENDYOL", "HEPSIBURADA"] })
  @IsIn(["TRENDYOL", "HEPSIBURADA"])
  marketplace!: "TRENDYOL" | "HEPSIBURADA";

  @ApiProperty()
  @IsString()
  @MinLength(1)
  category!: string;

  /** Oran 0–1 (örn. 0.12 = %12) veya 0–100 (örn. 12). */
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  plusRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ApplyTariffDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({ enum: ["TRENDYOL", "HEPSIBURADA"] })
  @IsOptional()
  @IsIn(["TRENDYOL", "HEPSIBURADA"])
  marketplace?: "TRENDYOL" | "HEPSIBURADA";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: "Plus tarifesini uygula" })
  @IsOptional()
  @IsBoolean()
  usePlus?: boolean;

  @ApiPropertyOptional({ description: "Yalnız bu mağazadaki ürünlere uygula" })
  @IsOptional()
  @IsUUID()
  storeId?: string;
}

export class UpsertTariffOverrideDto {
  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  category!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  plusRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class TariffImportRowDto {
  @ApiProperty({ enum: ["TRENDYOL", "HEPSIBURADA"] })
  @IsIn(["TRENDYOL", "HEPSIBURADA"])
  marketplace!: "TRENDYOL" | "HEPSIBURADA";

  @ApiProperty()
  @IsString()
  @MinLength(1)
  category!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  plusRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ImportTariffsDto {
  @ApiProperty({ type: [TariffImportRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TariffImportRowDto)
  rows!: TariffImportRowDto[];
}
