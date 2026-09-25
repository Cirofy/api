import { IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateCheckoutDto {
  @ApiProperty({ enum: ["starter", "business", "enterprise"] })
  @IsEnum(["starter", "business", "enterprise"])
  planId!: "starter" | "business" | "enterprise";

  @ApiProperty({ enum: ["month", "year"] })
  @IsEnum(["month", "year"])
  billingInterval!: "month" | "year";
}
