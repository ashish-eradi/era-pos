import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

export type Country = 'IN' | 'US';
export const defaults = {
  mixed: [], apparel: ['size', 'colour'], stationery: [], home_goods: ['material'], packaged_grocery: ['pack size'],
} as const;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function secret(): string {
  return randomBytes(32).toString('base64url');
}

export function bearer(authorization: string | undefined): string {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) throw new UnauthorizedException();
  return digest(token);
}

export function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || value.includes('\0')) {
    throw new BadRequestException(`Provide a valid ${field}`);
  }
  return value.trim();
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Specify the request fields');
  return value as Record<string, unknown>;
}

export function email(value: unknown): string {
  const address = text(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new BadRequestException('Provide a valid email address');
  return address;
}

export function uuid(value: unknown, field: string): string {
  const id = text(value, field, 36).toLowerCase();
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id)) throw new BadRequestException(`Provide a valid ${field}`);
  return id;
}

export async function transaction<T>(database: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function owner(client: PoolClient, merchantId: string, authorization?: string): Promise<string> {
  const { rows } = await client.query<{ id: string; role: string }>(`
    SELECT m.id, m.role FROM membership_sessions s
    JOIN memberships m ON (m.merchant_id, m.id) = (s.merchant_id, s.membership_id)
    WHERE s.token_digest = $1 AND s.merchant_id = $2 AND m.active
      AND s.revoked_at IS NULL AND s.expires_at > now()
    FOR SHARE OF m, s
  `, [bearer(authorization), merchantId]);
  if (!rows[0]) throw new UnauthorizedException();
  if (rows[0].role !== 'owner') throw new ForbiddenException();
  return rows[0].id;
}
