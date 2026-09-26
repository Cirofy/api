import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type MailSendResult =
  | { ok: true; mode: "smtp" | "simulate"; messageId?: string }
  | { ok: false; mode: "smtp" | "simulate" | "off"; error: string };

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    this.transporter = this.buildTransporter();
  }

  /** SMTP yapılandırılmış mı (kullanıcıya sağlayıcı adı dönülmez). */
  isSmtpConfigured(): boolean {
    return this.transporter != null;
  }

  async send(mail: OutboundMail): Promise<MailSendResult> {
    const to = mail.to.trim().toLowerCase();
    if (!to || !to.includes("@")) {
      return { ok: false, mode: "off", error: "Geçersiz e-posta adresi" };
    }

    if (this.transporter) {
      try {
        const from =
          this.config.get<string>("MAIL_FROM")?.trim() ||
          "Cirofy <rapor@cirofy.local>";
        const info = await this.transporter.sendMail({
          from,
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html ?? undefined,
        });
        this.logger.log(`Mail sent to=${to} id=${info.messageId ?? "?"}`);
        return { ok: true, mode: "smtp", messageId: info.messageId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Gönderim başarısız";
        this.logger.warn(`Mail failed to=${to}: ${msg}`);
        return { ok: false, mode: "smtp", error: "E-posta gönderilemedi" };
      }
    }

    // Geliştirme: SMTP yokken kuyruk simülasyonu (log)
    this.logger.log(
      `[simulate] to=${to} subject=${mail.subject} body=${mail.text.slice(0, 120)}…`,
    );
    return { ok: true, mode: "simulate" };
  }

  private buildTransporter(): Transporter | null {
    const host = this.config.get<string>("MAIL_SMTP_HOST")?.trim();
    if (!host) return null;
    const port = Number(this.config.get<string>("MAIL_SMTP_PORT") ?? "587");
    const user = this.config.get<string>("MAIL_SMTP_USER")?.trim();
    const pass = this.config.get<string>("MAIL_SMTP_PASS")?.trim();
    const secure =
      this.config.get<string>("MAIL_SMTP_SECURE") === "true" || port === 465;

    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });
  }
}
