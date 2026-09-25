import { IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CaptureBuyboxDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  sku!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  marketplace!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  buyboxPrice!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  ourPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  merchantName?: string;

  @ApiPropertyOptional({ enum: ["us", "competitor"] })
  @IsOptional()
  @IsIn(["us", "competitor"])
  winner?: "us" | "competitor";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  capturedAt?: string;
}
