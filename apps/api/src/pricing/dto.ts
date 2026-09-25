import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class PriceApplyItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  salePrice!: number;
}

export class ApplyPricesDto {
  @ApiProperty({ type: [PriceApplyItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PriceApplyItemDto)
  items!: PriceApplyItemDto[];

  @ApiProperty({ description: "Geri alınamaz onay işareti" })
  @IsBoolean()
  acknowledged!: boolean;
}
