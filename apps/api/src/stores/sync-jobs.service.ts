import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { MarketplacePullError } from "../marketplace/pull-error";
import { StoresService } from "./stores.service";

export type SyncJobStatus = "queued" | "running" | "ok" | "error";

export type SyncJob = {
  id: string;
  organizationId: string;
  storeId: string;
  kind: "marketplace_pull";
  status: SyncJobStatus;
  message?: string;
  result?: { products?: number; orders?: number; source?: string };
  createdAt: string;
  finishedAt?: string;
};

@Injectable()
export class SyncJobsService {
  private readonly jobs = new Map<string, SyncJob>();

  constructor(private readonly stores: StoresService) {}

  list(organizationId: string, limit = 20) {
    return [...this.jobs.values()]
      .filter((j) => j.organizationId === organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  get(organizationId: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.organizationId !== organizationId) {
      throw new NotFoundException("Senkron işi bulunamadı");
    }
    return job;
  }

  enqueue(
    organizationId: string,
    storeId: string,
    kind: SyncJob["kind"] = "marketplace_pull",
  ) {
    const job: SyncJob = {
      id: randomUUID(),
      organizationId,
      storeId,
      kind,
      status: "queued",
      createdAt: new Date().toISOString(),
      message: "Kuyruğa alındı",
    };
    this.jobs.set(job.id, job);
    void this.run(job.id);
    return job;
  }

  private async run(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "running";
    job.message = "Pazaryeri çekimi çalışıyor";

    try {
      const result = await this.stores.pullMarketplaceData(
        job.organizationId,
        job.storeId,
      );
      job.status = "ok";
      job.result = {
        products: result.products,
        orders: result.orders,
        source: result.source,
      };
      job.message = result.message;
    } catch (err) {
      job.status = "error";
      if (err instanceof BadRequestException) {
        const res = err.getResponse();
        job.message =
          typeof res === "string"
            ? res
            : typeof res === "object" && res && "message" in res
              ? Array.isArray((res as { message: unknown }).message)
                ? String((res as { message: string[] }).message[0])
                : String((res as { message: string }).message)
              : "Senkron tamamlanamadı. Tekrar deneyin.";
      } else if (err instanceof MarketplacePullError) {
        job.message = err.message;
      } else {
        job.message = "Senkron tamamlanamadı. Tekrar deneyin.";
      }
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }
}
