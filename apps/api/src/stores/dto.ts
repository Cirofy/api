import { IsEnum, IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Marketplace } from "@prisma/client";

export class ConnectStoreDto {
  @ApiProperty({ enum: Marketplace })
  @IsEnum(Marketplace)
  marketplace!: Marketplace;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  externalStoreId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  apiKey!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  apiSecret!: string;
}
