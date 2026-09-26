import { IsBoolean, IsNumber, Max, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class UpdateRadarPrefsDto {
  @ApiProperty({ description: "Rakip fiyat düşüş alarm eşiği (%)" })
  @IsNumber()
  @Min(0)
  @Max(50)
  priceDropPctThreshold!: number;

  @ApiProperty()
  @IsBoolean()
  stockAlertEnabled!: boolean;
}
