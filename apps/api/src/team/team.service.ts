import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import type { InviteMemberDto, TeamRoleDto, UpdateMemberRoleDto } from "./dto";

const INVITE_TTL_MS = 14 * 24 * 3600_000;

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async list(organizationId: string) {
    const [memberships, invites] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId },
        include: {
          user: { select: { id: true, email: true, fullName: true, isActive: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.teamInvite.findMany({
        where: { organizationId, status: "pending" },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const members = [
      ...memberships.map((m) => ({
        id: m.id,
        userId: m.userId,
        fullName: m.user.fullName,
        email: m.user.email,
        role: toUiRole(m.role, m.teamRole),
        status: m.user.isActive ? ("active" as const) : ("pending" as const),
        kind: "member" as const,
        inviteToken: null as string | null,
        expiresAt: null as string | null,
      })),
      ...invites.map((i) => ({
        id: i.id,
        userId: null as string | null,
        fullName: i.fullName,
        email: i.email,
        role: (i.teamRole as TeamRoleDto) || "ops",
        status: "pending" as const,
        kind: "invite" as const,
        inviteToken: i.token,
        expiresAt: i.expiresAt.toISOString(),
      })),
    ];

    return {
      members,
      counts: {
        active: members.filter((m) => m.status === "active").length,
        pending: members.filter((m) => m.status === "pending").length,
      },
      source: "live" as const,
    };
  }

  async invite(organizationId: string, dto: InviteMemberDto) {
    const email = dto.email.toLowerCase().trim();
    const fullName = dto.fullName?.trim() || email.split("@")[0] || email;
    const role = dto.role;

    const existingMember = await this.prisma.membership.findFirst({
      where: { organizationId, user: { email } },
    });
    if (existingMember) {
      throw new BadRequestException("Bu e-posta zaten ekipte");
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });

    const existingInvite = await this.prisma.teamInvite.findUnique({
      where: { organizationId_email: { organizationId, email } },
    });

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = existingInvite
      ? await this.prisma.teamInvite.update({
          where: { id: existingInvite.id },
          data: {
            fullName,
            teamRole: role,
            status: "pending",
            token,
            expiresAt,
            acceptedAt: null,
          },
        })
      : await this.prisma.teamInvite.create({
          data: {
            organizationId,
            email,
            fullName,
            teamRole: role,
            status: "pending",
            token,
            expiresAt,
          },
        });

    const acceptPath = `/register?invite=${invite.token}`;
    const mailResult = await this.mail.send({
      to: email,
      subject: `${org?.name || "Cirofy"} ekip daveti`,
      text: [
        `Merhaba ${fullName},`,
        "",
        `${org?.name || "Bir organizasyon"} sizi Cirofy ekibine davet etti.`,
        `Rol: ${roleLabel(role)}`,
        "",
        `Kabul için kayıt olun: ${acceptPath}`,
        `Davet kodu: ${invite.token}`,
        `Son geçerlilik: ${expiresAt.toISOString().slice(0, 10)}`,
        "",
        "— Cirofy",
      ].join("\n"),
      html: `<div style="font-family:system-ui,sans-serif;color:#0B1424;line-height:1.5">
  <p>Merhaba <strong>${escapeHtml(fullName)}</strong>,</p>
  <p><strong>${escapeHtml(org?.name || "Bir organizasyon")}</strong> sizi Cirofy ekibine davet etti.</p>
  <p>Rol: ${escapeHtml(roleLabel(role))}</p>
  <p>Kayıt olurken davet kodunu kullanın veya şu bağlantıyı açın:</p>
  <p><code style="background:#EEF2F6;padding:4px 8px;border-radius:6px">${escapeHtml(invite.token)}</code></p>
  <p style="color:#64748b;font-size:13px">Son geçerlilik: ${expiresAt.toISOString().slice(0, 10)}</p>
</div>`,
    });

    const mailNote = mailResult.ok
      ? mailResult.mode === "smtp"
        ? "Davet e-postası gönderildi."
        : "Davet kaydedildi."
      : "Davet kaydedildi; e-posta gönderilemedi.";

    return {
      id: invite.id,
      fullName: invite.fullName,
      email: invite.email,
      role: invite.teamRole as TeamRoleDto,
      status: "pending" as const,
      kind: "invite" as const,
      inviteToken: invite.token,
      expiresAt: invite.expiresAt.toISOString(),
      acceptPath,
      message: mailNote,
    };
  }

  /** Oturum açmış kullanıcı daveti kabul eder (e-posta eşleşmeli). */
  async acceptInvite(
    userId: string,
    userEmail: string,
    token: string,
  ) {
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token },
    });
    if (!invite || invite.status !== "pending") {
      throw new NotFoundException("Davet bulunamadı veya kullanılmış");
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("Davetin süresi dolmuş");
    }
    if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new BadRequestException("Davet bu e-posta için değil");
    }

    const existing = await this.prisma.membership.findFirst({
      where: { organizationId: invite.organizationId, userId },
    });
    if (existing) {
      await this.prisma.teamInvite.update({
        where: { id: invite.id },
        data: { status: "accepted", acceptedAt: new Date() },
      });
      return {
        ok: true as const,
        organizationId: invite.organizationId,
        message: "Zaten bu organizasyondasınız.",
      };
    }

    await this.prisma.$transaction([
      this.prisma.membership.create({
        data: {
          organizationId: invite.organizationId,
          userId,
          role: "MEMBER",
          teamRole: invite.teamRole,
        },
      }),
      this.prisma.teamInvite.update({
        where: { id: invite.id },
        data: { status: "accepted", acceptedAt: new Date() },
      }),
    ]);

    return {
      ok: true as const,
      organizationId: invite.organizationId,
      role: invite.teamRole,
      message: "Davet kabul edildi.",
    };
  }

  async peekInvite(token: string) {
    const invite = await this.prisma.teamInvite.findUnique({
      where: { token },
      include: { organization: { select: { name: true } } },
    });
    if (!invite || invite.status !== "pending") {
      return { valid: false as const, message: "Davet geçersiz" };
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      return { valid: false as const, message: "Davetin süresi dolmuş" };
    }
    return {
      valid: true as const,
      email: invite.email,
      fullName: invite.fullName,
      role: invite.teamRole,
      organizationName: invite.organization.name,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async updateRole(
    organizationId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: { id: memberId, organizationId },
    });
    if (membership) {
      if (membership.role === "OWNER" && dto.role !== "owner") {
        throw new BadRequestException("Sahip rolü değiştirilemez");
      }
      if (dto.role === "owner") {
        await this.prisma.membership.update({
          where: { id: membership.id },
          data: { role: "OWNER", teamRole: "owner" },
        });
      } else {
        await this.prisma.membership.update({
          where: { id: membership.id },
          data: { role: "MEMBER", teamRole: dto.role },
        });
      }
      return { id: membership.id, role: dto.role, message: "Rol güncellendi." };
    }

    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!invite) throw new NotFoundException("Üye bulunamadı");
    if (dto.role === "owner") {
      throw new BadRequestException("Davete sahip rolü verilemez");
    }
    await this.prisma.teamInvite.update({
      where: { id: invite.id },
      data: { teamRole: dto.role },
    });
    return { id: invite.id, role: dto.role, message: "Davet rolü güncellendi." };
  }

  async remove(organizationId: string, memberId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { id: memberId, organizationId },
      include: { user: { select: { fullName: true } } },
    });
    if (membership) {
      if (membership.role === "OWNER") {
        throw new BadRequestException("Sahip ekipten çıkarılamaz");
      }
      await this.prisma.membership.delete({ where: { id: membership.id } });
      return {
        removed: true,
        message: `${membership.user.fullName} ekipten çıkarıldı.`,
      };
    }

    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!invite) throw new NotFoundException("Üye bulunamadı");
    await this.prisma.teamInvite.delete({ where: { id: invite.id } });
    return { removed: true, message: `${invite.fullName} daveti iptal edildi.` };
  }
}

function toUiRole(
  role: "OWNER" | "MEMBER" | "ADMIN" | "SUPER_ADMIN",
  teamRole: string,
): TeamRoleDto {
  if (role === "OWNER" || role === "ADMIN" || role === "SUPER_ADMIN") {
    return "owner";
  }
  if (teamRole === "finance" || teamRole === "agency" || teamRole === "ops") {
    return teamRole;
  }
  return "ops";
}

function roleLabel(role: string) {
  if (role === "finance") return "Finans";
  if (role === "agency") return "Ajans";
  return "Operasyon";
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
