import { IsIn } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class UpdateSettlementIssueDto {
  @ApiProperty({ enum: ["open", "resolved"] })
  @IsIn(["open", "resolved"])
  status!: "open" | "resolved";
}
