import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CostRowDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  costVatRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  desi?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionRate?: number;
}

export class UpdateCostsDto {
  @ApiProperty({ type: [CostRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CostRowDto)
  rows!: CostRowDto[];
}

export class AssignCategoryDto {
  @ApiPropertyOptional({
    description: "Boşsa kategori eksik tüm aktif ürünler",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  @ApiPropertyOptional({ default: "Diğer" })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description: "true ise kategori tarifesinden komisyon da çekilir",
  })
  @IsOptional()
  @IsBoolean()
  applyTariff?: boolean;

  @ApiPropertyOptional({ description: "applyTariff ile Plus oranı" })
  @IsOptional()
  @IsBoolean()
  usePlus?: boolean;
}
