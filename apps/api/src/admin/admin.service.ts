import { ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  assertAdmin(role: string) {
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      throw new ForbiddenException("Admin yetkisi gerekli");
    }
  }

  async overview() {
    const since7 = new Date(Date.now() - 7 * 86400_000);
    const [
      users,
      organizations,
      stores,
      products,
      orders,
      openTickets,
      recentLogins,
      subscriptions,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.organization.count(),
      this.prisma.store.count(),
      this.prisma.product.count(),
      this.prisma.order.count(),
      this.prisma.supportTicket.count({ where: { status: "open" } }),
      this.prisma.user.count({
        where: { lastLoginAt: { gte: since7 } },
      }),
      this.prisma.subscription.groupBy({
        by: ["status"],
        _count: true,
      }),
    ]);

    return {
      users,
      organizations,
      stores,
      products,
      orders,
      openTickets,
      recentLogins7d: recentLogins,
      subscriptions: subscriptions.map((s) => ({
        status: s.status,
        count: s._count,
      })),
    };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      take: 200,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        memberships: {
          take: 1,
          select: {
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
                _count: {
                  select: {
                    stores: true,
                    products: true,
                    orders: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return users.map((u) => {
      const org = u.memberships[0]?.organization ?? null;
      return {
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        isActive: u.isActive,
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        organization: org
          ? {
              id: org.id,
              name: org.name,
              slug: org.slug,
              stores: org._count.stores,
              products: org._count.products,
              orders: org._count.orders,
            }
          : null,
      };
    });
  }

  async listStores() {
    const stores = await this.prisma.store.findMany({
      take: 200,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        marketplace: true,
        isConnected: true,
        externalStoreId: true,
        lastSyncAt: true,
        createdAt: true,
        organization: {
          select: { id: true, name: true, slug: true },
        },
        _count: { select: { products: true, orders: true } },
      },
    });

    return stores.map((s) => ({
      id: s.id,
      name: s.name,
      marketplace: s.marketplace,
      isConnected: s.isConnected,
      externalStoreId: s.externalStoreId,
      lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      organization: s.organization,
      products: s._count.products,
      orders: s._count.orders,
      hasSellerId: Boolean(s.externalStoreId?.trim()),
    }));
  }

  async listTickets() {
    const tickets = await this.prisma.supportTicket.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        topic: true,
        subject: true,
        body: true,
        status: true,
        priority: true,
        contactEmail: true,
        createdAt: true,
        resolvedAt: true,
        organization: {
          select: { id: true, name: true, slug: true },
        },
      },
    });

    return tickets.map((t) => ({
      id: t.id,
      topic: t.topic,
      subject: t.subject,
      body: t.body,
      status: t.status,
      priority: t.priority,
      contactEmail: t.contactEmail,
      createdAt: t.createdAt.toISOString(),
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      organization: t.organization,
    }));
  }

  async orgHealth(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        stores: {
          select: {
            id: true,
            name: true,
            marketplace: true,
            isConnected: true,
            lastSyncAt: true,
            _count: { select: { products: true, orders: true } },
          },
        },
        memberships: {
          select: {
            role: true,
            user: {
              select: {
                email: true,
                fullName: true,
                lastLoginAt: true,
              },
            },
          },
        },
      },
    });
    if (!org) return null;

    const [products, withCost, openTickets] = await Promise.all([
      this.prisma.product.count({ where: { organizationId } }),
      this.prisma.product.count({
        where: { organizationId, costPrice: { gt: 0 } },
      }),
      this.prisma.supportTicket.count({
        where: { organizationId, status: "open" },
      }),
    ]);

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt.toISOString(),
      members: org.memberships.map((m) => ({
        email: m.user.email,
        fullName: m.user.fullName,
        role: m.role,
        lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      })),
      stores: org.stores.map((s) => ({
        id: s.id,
        name: s.name,
        marketplace: s.marketplace,
        isConnected: s.isConnected,
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        products: s._count.products,
        orders: s._count.orders,
      })),
      products,
      productsWithCost: withCost,
      costCoveragePct:
        products > 0 ? Math.round((withCost / products) * 1000) / 10 : 0,
      openTickets,
    };
  }
}
