import pino from 'pino';

const logger = pino({ name: 'email-sender' });

export interface EmailRecipient {
  email: string;
  name?: string;
}

export interface SendEmailOptions {
  to: string[] | EmailRecipient[];
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSenderConfig {
  secretKey: string;
  projectId: string;
  senderEmail: string;
  senderName?: string;
  region?: string;
  apiUrl?: string;
}

export class EmailSender {
  private config: EmailSenderConfig;
  public sentEmails: Array<{ to: string[]; subject: string; text: string; html?: string; sentAt: number }> = [];

  constructor(config: EmailSenderConfig) {
    this.config = {
      region: 'fr-par',
      apiUrl: 'https://api.scaleway.com',
      senderName: 'ADHD Budget',
      ...config,
    };
  }

  async send(options: SendEmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const recipients: EmailRecipient[] = options.to.map(r => {
      if (typeof r === 'string') {
        const name = r.split('@')[0];
        return { email: r, name: name.charAt(0).toUpperCase() + name.slice(1) };
      }
      return r;
    });

    // In test environment or dry-run mode without credentials, record in memory
    if (process.env.NODE_ENV === 'test' || !this.config.secretKey) {
      this.sentEmails.push({
        to: recipients.map(r => r.email),
        subject: options.subject,
        text: options.text,
        html: options.html,
        sentAt: Date.now(),
      });
      logger.info({ to: recipients.map(r => r.email), subject: options.subject }, 'test_email_recorded');
      return { success: true, messageId: `mock-${Date.now()}` };
    }

    const endpoint = `${this.config.apiUrl}/transactional-email/v1alpha1/regions/${this.config.region}/emails`;
    const payload = {
      project_id: this.config.projectId,
      from: {
        email: this.config.senderEmail,
        name: this.config.senderName || 'ADHD Budget',
      },
      to: recipients.map(r => ({
        email: r.email,
        name: r.name || r.email.split('@')[0],
      })),
      subject: options.subject,
      text: options.text,
      html: options.html || options.text,
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.config.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.text();
        logger.error({ status: res.status, err: errBody }, 'scaleway_tem_send_failed');
        return { success: false, error: `TEM API ${res.status}: ${errBody}` };
      }

      const data = await res.json() as { emails?: Array<{ id: string; message_id?: string }> };
      const msgId = data.emails?.[0]?.id || data.emails?.[0]?.message_id || 'sent';

      this.sentEmails.push({
        to: recipients.map(r => r.email),
        subject: options.subject,
        text: options.text,
        html: options.html,
        sentAt: Date.now(),
      });

      logger.info({ to: recipients.map(r => r.email), subject: options.subject, msgId }, 'email_dispatched_successfully');
      return { success: true, messageId: msgId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg }, 'email_dispatch_exception');
      return { success: false, error: errMsg };
    }
  }
}
