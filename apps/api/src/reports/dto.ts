import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateMailPrefsDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsBoolean()
  daily!: boolean;

  @ApiProperty()
  @IsBoolean()
  monthly!: boolean;

  @ApiPropertyOptional({ description: "Tarife değişince e-posta bildir" })
  @IsOptional()
  @IsBoolean()
  tariffChange?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 23, description: "UTC gönderim saati" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  sendHourUtc?: number;
}

export class EnqueueDigestDto {
  @ApiProperty({ enum: ["daily", "monthly"] })
  @IsEnum(["daily", "monthly"])
  cadence!: "daily" | "monthly";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
