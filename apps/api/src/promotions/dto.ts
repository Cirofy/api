import { Type } from "class-transformer";
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class PromoImportRowDto {
  @ApiProperty()
  @IsString()
  sku!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  offerPrice!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  listPrice?: number;
}

export class ImportPromoOffersDto {
  @ApiProperty({ type: [PromoImportRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromoImportRowDto)
  rows!: PromoImportRowDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  targetMargin?: number;
}
