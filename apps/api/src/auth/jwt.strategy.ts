import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../prisma/prisma.service";

type JwtPayload = {
  sub: string;
  email: string;
  role: string;
  orgId: string | null;
  teamRole?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("JWT_ACCESS_SECRET") ?? "dev-secret",
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        memberships: { include: { organization: true }, take: 1 },
      },
    });
    if (!user || !user.isActive) return null;
    const membership = user.memberships[0];
    const teamRole = normalizeTeamRole(membership?.teamRole, user.role);
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      teamRole,
      organization: membership?.organization ?? null,
    };
  }
}

function normalizeTeamRole(
  teamRole: string | undefined,
  platformRole: string,
): "owner" | "ops" | "finance" | "agency" {
  if (
    platformRole === "OWNER" ||
    platformRole === "ADMIN" ||
    platformRole === "SUPER_ADMIN"
  ) {
    return "owner";
  }
  if (
    teamRole === "owner" ||
    teamRole === "ops" ||
    teamRole === "finance" ||
    teamRole === "agency"
  ) {
    return teamRole;
  }
  return "ops";
}
