import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateSupportTicketDto, SupportPriority } from "./dto";

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    const items = rows
      .map((r) => ({
        id: r.id,
        topic: r.topic,
        subject: r.subject,
        body: r.body,
        status: r.status,
        priority: (r.priority || "normal") as SupportPriority,
        contactEmail: r.contactEmail,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        tags: ticketTags(r.topic, r.subject, r.body),
      }))
      .sort((a, b) => {
        if (a.status !== b.status) {
          return a.status === "open" ? -1 : 1;
        }
        const pr = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
        if (pr !== 0) return pr;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });

    return {
      items,
      source: items.length ? ("persisted" as const) : ("empty" as const),
    };
  }

  async create(organizationId: string, dto: CreateSupportTicketDto) {
    const priority = dto.priority ?? defaultPriorityForTopic(dto.topic);
    const row = await this.prisma.supportTicket.create({
      data: {
        organizationId,
        topic: dto.topic,
        subject: dto.subject.trim(),
        body: dto.body.trim(),
        contactEmail: dto.contactEmail?.trim() || null,
        status: "open",
        priority,
      },
    });
    return {
      item: {
        id: row.id,
        topic: row.topic,
        subject: row.subject,
        body: row.body,
        status: row.status,
        priority: row.priority as SupportPriority,
        contactEmail: row.contactEmail,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: null,
        tags: ticketTags(row.topic, row.subject, row.body),
      },
      message:
        priority === "urgent" || priority === "high"
          ? "Talebiniz yüksek öncelikle alındı. En kısa sürede dönüş yapacağız."
          : "Talebiniz alındı. En kısa sürede dönüş yapacağız.",
    };
  }
}

function ticketTags(topic: string, subject: string, body: string): string[] {
  const tags: string[] = [];
  const blob = `${topic} ${subject} ${body}`.toLowerCase();
  if (topic === "tariff" || blob.includes("tarif") || blob.includes("komisyon")) {
    tags.push("tariff");
  }
  if (topic === "settlement" || blob.includes("hakediş") || blob.includes("hakedis")) {
    tags.push("settlement");
  }
  return tags;
}

function defaultPriorityForTopic(topic: string): SupportPriority {
  if (topic === "settlement" || topic === "billing") return "high";
  if (topic === "tariff" || topic === "connection" || topic === "data") {
    return "normal";
  }
  return "low";
}
