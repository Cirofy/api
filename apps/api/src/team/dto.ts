import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export const TEAM_ROLES = ["owner", "ops", "finance", "agency"] as const;
export type TeamRoleDto = (typeof TEAM_ROLES)[number];

export class InviteMemberDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  fullName?: string;

  @ApiProperty({ enum: ["ops", "finance", "agency"] })
  @IsIn(["ops", "finance", "agency"])
  role!: Exclude<TeamRoleDto, "owner">;
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: TEAM_ROLES })
  @IsIn(TEAM_ROLES)
  role!: TeamRoleDto;
}

export class AcceptInviteDto {
  @ApiProperty()
  @IsUUID()
  token!: string;
}
