import { describe, it, expect } from 'vitest';
import {
  cleanMerchantAndCategory,
  isInternalTransfer,
  analyzeSpending,
  detectSubscriptions,
  calculateCashflowForecast,
  type CleanTransaction,
} from '../../src/analysis/polish-finance.js';

describe('Polish Finance Analysis', () => {
  it('correctly normalizes Polish merchants and categories', () => {
    const t1 = cleanMerchantAndCategory('ZAKUP PRZY UŻYCIU KODU BLIK 123456 BIEDRONKA 4920');
    expect(t1.merchant).toBe('Biedronka');
    expect(t1.category).toBe('Groceries');

    const t2 = cleanMerchantAndCategory('PŁATNOŚĆ KARTĄ 04.09.2026 ŻABKA Z4920 KRAKÓW PL');
    expect(t2.merchant).toBe('Żabka');
    expect(t2.category).toBe('Groceries');

    const t3 = cleanMerchantAndCategory('STACJA PALIW ORLEN NR 1234');
    expect(t3.merchant).toBe('Orlen');
    expect(t3.category).toBe('Transport & Fuel');

    const t4 = cleanMerchantAndCategory('PAYU SA / ALLEGRO.PL TYT: 192837198');
    expect(t4.merchant).toBe('Allegro');
    expect(t4.category).toBe('Shopping');

    const t5 = cleanMerchantAndCategory('NETFLIX.COM AMSTERDAM NLD');
    expect(t5.merchant).toBe('Netflix');
    expect(t5.category).toBe('Subscriptions');
  });

  it('detects internal transfers and skips them in spend calculations', () => {
    expect(isInternalTransfer('PRZELEW WŁASNY Z RACHUNKU')).toBe(true);
    expect(isInternalTransfer('REVOLUT TOP UP')).toBe(true);
    expect(isInternalTransfer('ZASILENIE REVOLUT')).toBe(true);
    expect(isInternalTransfer('OPŁATA ZA ZAKUPY W DINO')).toBe(false);
  });

  it('computes spending analysis, detects outliers, and calculates daily burn', () => {
    const transactions: CleanTransaction[] = [
      {
        id: '1',
        bank: 'PKO Bank Polski',
        account_id: 'acc1',
        date: '2026-09-01',
        amount: -50.0,
        currency: 'PLN',
        merchant: 'Biedronka',
        category: 'Groceries',
        raw_description: 'Biedronka zakupy',
        is_internal_transfer: false,
        is_income: false,
      },
      {
        id: '2',
        bank: 'PKO Bank Polski',
        account_id: 'acc1',
        date: '2026-09-02',
        amount: -30.0,
        currency: 'PLN',
        merchant: 'Żabka',
        category: 'Groceries',
        raw_description: 'Żabka kawa',
        is_internal_transfer: false,
        is_income: false,
      },
      {
        id: '3',
        bank: 'PKO Bank Polski',
        account_id: 'acc1',
        date: '2026-09-03',
        amount: -1500.0, // Big outlier!
        currency: 'PLN',
        merchant: 'MediaMarkt',
        category: 'Electronics',
        raw_description: 'MediaMarkt telewizor',
        is_internal_transfer: false,
        is_income: false,
      },
      {
        id: '4',
        bank: 'PKO Bank Polski',
        account_id: 'acc1',
        date: '2026-09-04',
        amount: -1000.0,
        currency: 'PLN',
        merchant: 'Revolut',
        category: 'Transfers',
        raw_description: 'Przelew własny na Revolut',
        is_internal_transfer: true, // Should be ignored in spend!
        is_income: false,
      },
    ];

    const analysis = analyzeSpending(transactions, 'this_month', 5);
    expect(analysis.total_spent_pln).toBe(1580.0);
    expect(analysis.internal_transfers_excluded.length).toBe(1);
    expect(analysis.outliers.length).toBe(1);
    expect(analysis.outliers[0].merchant).toBe('MediaMarkt');
    expect(analysis.daily_burn_rate_pln).toBe(316.0);
  });

  it('detects subscriptions and recurring payments', () => {
    const transactions: CleanTransaction[] = [
      {
        id: '1',
        bank: 'Revolut',
        account_id: 'acc2',
        date: '2026-08-05',
        amount: -43.0,
        currency: 'PLN',
        merchant: 'Netflix',
        category: 'Subscriptions',
        raw_description: 'Netflix',
        is_internal_transfer: false,
        is_income: false,
      },
      {
        id: '2',
        bank: 'Revolut',
        account_id: 'acc2',
        date: '2026-09-05',
        amount: -43.0,
        currency: 'PLN',
        merchant: 'Netflix',
        category: 'Subscriptions',
        raw_description: 'Netflix',
        is_internal_transfer: false,
        is_income: false,
      },
      {
        id: '3',
        bank: 'PKO Bank Polski',
        account_id: 'acc1',
        date: '2026-09-02',
        amount: -25.0,
        currency: 'PLN',
        merchant: 'Spotify',
        category: 'Subscriptions',
        raw_description: 'Spotify',
        is_internal_transfer: false,
        is_income: false,
      },
    ];

    const subs = detectSubscriptions(transactions);
    expect(subs.length).toBe(2);
    expect(subs.map(s => s.merchant)).toContain('Netflix');
    expect(subs.map(s => s.merchant)).toContain('Spotify');
  });

  it('projects cashflow and safe-to-spend limit', () => {
    const subs = [{ merchant: 'Netflix', category: 'Subscriptions', monthly_amount: 50, occurrences: 1, last_date: '2026-09-01', frequency: 'monthly' as const }];
    const forecast = calculateCashflowForecast(5000, 1000, subs, 10, 30);
    expect(forecast.days_remaining).toBe(20);
    expect(forecast.safe_daily_spend_limit_pln).toBeGreaterThan(200);
    expect(forecast.status).toBe('on_track');
  });
});
