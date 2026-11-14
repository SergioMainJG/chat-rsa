import { describe, expect, test } from 'bun:test';

import { connectionBannerText, mergeStatus, STATUS_LABEL } from './chat.status.ts';

describe('mergeStatus', () => {
  test('the rendered status never moves backwards', () => {
    expect(mergeStatus('delivered', 'sent')).toBe('delivered');
    expect(mergeStatus('read', 'delivered')).toBe('read');
    expect(mergeStatus('read', 'pending')).toBe('read');
    expect(mergeStatus('sent', 'pending')).toBe('sent');
  });

  test('moves forward through pending, sent, delivered, read', () => {
    expect(mergeStatus(undefined, 'pending')).toBe('pending');
    expect(mergeStatus('pending', 'sent')).toBe('sent');
    expect(mergeStatus('sent', 'delivered')).toBe('delivered');
    expect(mergeStatus('delivered', 'read')).toBe('read');
  });

  test('a first status may already be past pending (history, receipts)', () => {
    expect(mergeStatus(undefined, 'delivered')).toBe('delivered');
    expect(mergeStatus(undefined, 'read')).toBe('read');
  });
});

describe('STATUS_LABEL', () => {
  test('labels every local status', () => {
    expect(STATUS_LABEL).toEqual({ delivered: 'Delivered', pending: 'Pending', read: 'Read', sent: 'Sent' });
  });
});

describe('connectionBannerText', () => {
  test('describes every state but open and closed', () => {
    expect(connectionBannerText('open')).toBe('');
    expect(connectionBannerText('closed')).toBe('');
    expect(connectionBannerText('connecting')).toBe('Connecting…');
    expect(connectionBannerText('reconnecting')).toBe('Connection lost. Reconnecting…');
    expect(connectionBannerText('offline')).toBe(
      'You are offline. Messages you send are kept and sent when the connection returns.',
    );
    expect(connectionBannerText('unauthorized')).toBe('Your session has ended. Sign in again.');
  });
});
