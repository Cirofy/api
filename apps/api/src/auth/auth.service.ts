import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { LoginDto, RegisterDto } from "./dto";

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existing) {
      throw new ConflictException("Bu e-posta zaten kayıtlı");
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    if (dto.inviteToken) {
      return this.registerWithInvite(dto, email, passwordHash);
    }

    const company = dto.companyName?.trim() || `${dto.fullName} Mağazası`;
    const baseSlug = slugify(company) || "org";
    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName: dto.fullName,
        memberships: {
          create: {
            role: "OWNER",
            teamRole: "owner",
            organization: {
              create: {
                name: company,
                slug,
                subscription: {
                  create: {
                    planId: "STARTER",
                    status: "TRIALING",
                    trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                  },
                },
              },
            },
          },
        },
      },
      include: {
        memberships: { include: { organization: true } },
      },
    });

    return this.issueTokens(user);
  }

  private async registerWithInvite(
    dto: RegisterDto,
    email: string,
    passwordHash: string,
  ) {
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token: dto.inviteToken },
      include: { organization: true },
    });
    if (!invite || invite.status !== "pending") {
      throw new BadRequestException("Davet geçersiz veya kullanılmış");
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("Davetin süresi dolmuş");
    }
    if (invite.email.toLowerCase() !== email) {
      throw new BadRequestException("Davet bu e-posta için değil");
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: dto.fullName,
          memberships: {
            create: {
              organizationId: invite.organizationId,
              role: "MEMBER",
              teamRole: invite.teamRole,
            },
          },
        },
        include: {
          memberships: { include: { organization: true } },
        },
      });
      await tx.teamInvite.update({
        where: { id: invite.id },
        data: { status: "accepted", acceptedAt: new Date() },
      });
      return created;
    });

    return this.issueTokens(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: { memberships: { include: { organization: true } } },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Geçersiz kimlik bilgileri");
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException("Geçersiz kimlik bilgileri");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    const secret =
      this.config.get<string>("JWT_REFRESH_SECRET") ??
      this.config.get<string>("JWT_ACCESS_SECRET") ??
      "dev-secret";
    let payload: { sub?: string; typ?: string };
    try {
      payload = this.jwt.verify(refreshToken, { secret }) as {
        sub?: string;
        typ?: string;
      };
    } catch {
      throw new UnauthorizedException("Oturum yenilenemedi. Tekrar giriş yapın.");
    }
    if (!payload.sub || payload.typ !== "refresh") {
      throw new UnauthorizedException("Oturum yenilenemedi. Tekrar giriş yapın.");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { memberships: { include: { organization: true } } },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Oturum yenilenemedi. Tekrar giriş yapın.");
    }

    return this.issueTokens(user);
  }

  private issueTokens(user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    memberships: Array<{
      organizationId: string;
      teamRole: string;
      organization: { id: string; name: string; slug: string };
    }>;
  }) {
    const membership = user.memberships[0];
    const org = membership?.organization;
    const teamRole = normalizeTeamRole(membership?.teamRole, user.role);
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      orgId: org?.id ?? null,
      teamRole,
    };

    const refreshSecret =
      this.config.get<string>("JWT_REFRESH_SECRET") ??
      this.config.get<string>("JWT_ACCESS_SECRET") ??
      "dev-secret";
    const refreshTtl = this.config.get<string>("JWT_REFRESH_TTL") ?? "30d";

    return {
      accessToken: this.jwt.sign(payload),
      refreshToken: this.jwt.sign(
        { sub: user.id, typ: "refresh" },
        {
          secret: refreshSecret,
          expiresIn: refreshTtl as `${number}d`,
        },
      ),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        teamRole,
        organization: org
          ? { id: org.id, name: org.name, slug: org.slug }
          : null,
      },
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
