import { Controller, Get, Query, Req, Sse, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { JwtService } from "@nestjs/jwt";
import { from, interval, map, Observable, startWith, switchMap } from "rxjs";
import {
  LiveService,
  type IntradaySnapshot,
  type LiveChannel,
} from "./live.service";

@ApiTags("live")
@Controller("live")
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly jwt: JwtService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("intraday")
  snapshot(
    @Req() req: { user: { organization: { id: string } | null } },
    @Query("channel") channelRaw?: string,
  ) {
    const orgId = req.user.organization?.id ?? "anon";
    return this.live.snapshot(orgId, parseChannel(channelRaw));
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("share")
  share(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id ?? "anon";
    return this.live.share(orgId);
  }

  /**
   * EventSource Authorization header gönderemez — ?token= ile JWT kabul edilir.
   * Geçersiz veya eksik token: boş gün içi özet.
   */
  @Sse("stream")
  stream(
    @Query("token") token?: string,
    @Query("channel") channelRaw?: string,
  ): Observable<{ data: IntradaySnapshot }> {
    let orgId = "anon";
    if (token) {
      try {
        const payload = this.jwt.verify<{ orgId?: string | null; sub?: string }>(
          token,
          {
            secret: process.env.JWT_ACCESS_SECRET,
          },
        );
        if (payload.orgId) orgId = payload.orgId;
      } catch {
        orgId = "anon";
      }
    }

    const channel = parseChannel(channelRaw);

    return interval(4000).pipe(
      startWith(0),
      switchMap(() => from(this.live.tick(orgId, channel))),
      map((data) => ({ data })),
    );
  }
}

function parseChannel(raw?: string): LiveChannel {
  if (raw === "Trendyol" || raw === "Hepsiburada") return raw;
  return "all";
}
