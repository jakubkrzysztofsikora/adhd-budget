import { SignJWT, importPKCS8 } from 'jose';
import type { KeyObject } from 'node:crypto';

export interface EnableBankingAuthResponse {
  url: string;
}

export interface EnableBankingSession {
  session_id: string;
  accounts: Array<{ uid: string; [key: string]: unknown }>;
  aspsp: { name: string; country: string };
  valid_until: string;
}

export interface EnableBankingBalance {
  balance_amount: { amount: string; currency: string };
  balance_type: string;
  [key: string]: unknown;
}

export interface EnableBankingTransaction {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: { amount: string; currency: string };
  value_date?: string;
  booking_date?: string;
  remittance_information_unstructured?: string;
  creditor_name?: string;
  debtor_name?: string;
  [key: string]: unknown;
}

export interface EnableBankingTransactionsResponse {
  transactions: EnableBankingTransaction[];
  continuation_key?: string;
}

export interface EnableBankingAspsp {
  name: string;
  country: string;
  [key: string]: unknown;
}

export class EnableBankingClient {
  private cachedKey: CryptoKey | KeyObject | null = null;

  constructor(
    private appId: string,
    private privateKeyPem: string,
    private baseUrl: string = 'https://api.enablebanking.com',
  ) {}

  private async getKey(): Promise<CryptoKey | KeyObject> {
    if (!this.cachedKey) {
      this.cachedKey = await importPKCS8(this.privateKeyPem, 'RS256');
    }
    return this.cachedKey;
  }

  async generateJwt(): Promise<string> {
    const key = await this.getKey();
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.appId })
      .setIssuer('enablebanking.com')
      .setAudience('api.enablebanking.com')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const jwt = await this.generateJwt();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new EnableBankingApiError(res.status, `Enable Banking API error ${res.status}: ${text}`, path);
    }

    return res.json() as Promise<T>;
  }

  async listAspsps(country: string): Promise<EnableBankingAspsp[]> {
    const response = await this.request<{ aspsps: EnableBankingAspsp[] }>('GET', `/aspsps?country=${encodeURIComponent(country)}`);
    return response.aspsps;
  }

  async initiateAuth(
    aspspName: string,
    aspspCountry: string,
    redirectUrl: string,
    state: string,
    psuType: string = 'personal',
  ): Promise<EnableBankingAuthResponse> {
    return this.request<EnableBankingAuthResponse>('POST', '/auth', {
      access: { valid_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() },
      aspsp: { name: aspspName, country: aspspCountry },
      state,
      redirect_url: redirectUrl,
      psu_type: psuType,
    });
  }

  async createSession(code: string): Promise<EnableBankingSession> {
    return this.request<EnableBankingSession>('POST', '/sessions', { code });
  }

  async getSession(sessionId: string): Promise<EnableBankingSession> {
    return this.request<EnableBankingSession>('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getAccountDetails(accountId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/accounts/${encodeURIComponent(accountId)}/details`);
  }

  async getBalances(accountId: string): Promise<EnableBankingBalance[]> {
    const response = await this.request<{ balances: EnableBankingBalance[] }>('GET', `/accounts/${encodeURIComponent(accountId)}/balances`);
    return response.balances;
  }

  async getTransactions(
    accountId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<EnableBankingTransaction[]> {
    const allTransactions: EnableBankingTransaction[] = [];
    let continuationKey: string | undefined;

    do {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (continuationKey) params.set('continuation_key', continuationKey);

      const qs = params.toString();
      const path = `/accounts/${encodeURIComponent(accountId)}/transactions${qs ? `?${qs}` : ''}`;
      const response = await this.request<EnableBankingTransactionsResponse>('GET', path);

      if (response.transactions?.length) {
        allTransactions.push(...response.transactions);
      }
      continuationKey = response.continuation_key ?? undefined;

      // Safety: cap at 500 transactions to prevent runaway pagination
      if (allTransactions.length >= 500) break;
    } while (continuationKey);

    return allTransactions;
  }

  async getTransactionDetails(
    accountId: string,
    transactionId: string,
  ): Promise<EnableBankingTransaction> {
    return this.request<EnableBankingTransaction>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/transactions/${encodeURIComponent(transactionId)}`,
    );
  }
}

export class EnableBankingApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public path: string,
  ) {
    super(message);
    this.name = 'EnableBankingApiError';
  }
}
