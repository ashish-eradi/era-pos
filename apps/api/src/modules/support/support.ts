import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Inject, NotFoundException,
  Param, Post, UnauthorizedException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { bearer, owner, record, text, transaction, uuid } from '../onboarding/shared';

type Ticket = {
  id: string; merchant_id: string; branch_id: string; register_id: string; assignee: string | null; resolved_at: Date | null;
};

async function support(database: Pool | PoolClient, authorization?: string): Promise<string> {
  const { rows } = await database.query<{ id: string; role: string }>(`
    SELECT o.id, o.role FROM platform_sessions s JOIN platform_operators o ON o.id = s.operator_id
    WHERE s.digest = $1 AND s.expires_at > clock_timestamp()
  `, [bearer(authorization)]);
  if (!rows[0]) throw new UnauthorizedException();
  if (rows[0].role !== 'support') throw new ForbiddenException();
  return rows[0].id;
}

async function ticket(client: PoolClient, id: string, merchant?: string): Promise<Ticket> {
  const { rows } = await client.query<Ticket>(`
    SELECT id, merchant_id, branch_id, register_id, assignee, resolved_at FROM support_tickets
    WHERE id = $1 AND ($2::text IS NULL OR merchant_id = $2) FOR UPDATE
  `, [uuid(id, 'ticket ID'), merchant ?? null]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

function event(client: PoolClient, target: Ticket, actor: { operator?: string; member?: string }, kind: string, message: string) {
  return client.query(`
    INSERT INTO support_events (merchant_id, branch_id, ticket_id, operator_id, membership_id, kind, message)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [target.merchant_id, target.branch_id, target.id, actor.operator ?? null, actor.member ?? null, kind, message]);
}

const ticketListing = `
  SELECT t.id, t.merchant_id AS "merchantId", t.branch_id AS "branchId", t.register_id AS "registerId",
    m.name AS merchant, b.name AS branch, r.name AS register, o.name AS assignee, t.assignee AS "assigneeId",
    t.resolved_at AS "resolvedAt", t.created_at AS "createdAt"
  FROM support_tickets t JOIN merchants m ON m.id = t.merchant_id
  JOIN branches b ON (b.merchant_id,b.id) = (t.merchant_id,t.branch_id)
  JOIN registers r ON (r.merchant_id,r.id) = (t.merchant_id,t.register_id)
  LEFT JOIN platform_operators o ON o.id = t.assignee
`;

@Controller('v1')
export class SupportController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('devices/heartbeat')
  async heartbeat(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    const device = uuid(data.deviceId, 'device ID');
    const version = text(data.appVersion, 'app version', 40);
    if (!/^[\da-z.+-]+$/i.test(version)) throw new BadRequestException('Invalid app version');
    const count = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
        throw new BadRequestException('Invalid queue count');
      }
      return value;
    };
    const oldest = data.oldestPendingAt ?? null;
    if (oldest !== null && (typeof oldest !== 'string' || !Number.isFinite(Date.parse(oldest)) ||
      new Date(oldest).toISOString() !== oldest)) throw new BadRequestException('Invalid queue timestamp');
    const result = await this.database.query(`
      INSERT INTO register_health (merchant_id, branch_id, register_id, observed_at, app_version, pending_count, rejected_count, oldest_pending_at)
      SELECT merchant_id, branch_id, id, clock_timestamp(), $3, $4, $5, $6 FROM registers
      WHERE device_id = $1 AND pairing_digest = $2 AND status = 'active'
      ON CONFLICT (merchant_id, register_id) DO UPDATE SET observed_at = EXCLUDED.observed_at,
        app_version = EXCLUDED.app_version, pending_count = EXCLUDED.pending_count,
        rejected_count = EXCLUDED.rejected_count, oldest_pending_at = EXCLUDED.oldest_pending_at
      WHERE register_health.observed_at <= EXCLUDED.observed_at
    `, [device, bearer(authorization), version, count(data.pending), count(data.rejected), oldest]);
    if (!result.rowCount) {
      const valid = await this.database.query("SELECT 1 FROM registers WHERE device_id = $1 AND pairing_digest = $2 AND status = 'active'",
        [device, bearer(authorization)]);
      if (!valid.rowCount) throw new UnauthorizedException();
    }
    return { received: true };
  }

  @Get('platform/support/queue')
  async queue(@Headers('authorization') authorization?: string) {
    const operatorId = await support(this.database, authorization);
    const stale = await this.staleRegisters(3);
    const tickets = await this.database.query(`${ticketListing} ORDER BY t.resolved_at NULLS FIRST, t.created_at DESC LIMIT 100`);
    return { operatorId, stale: stale.rows, tickets: tickets.rows };
  }

  @Get('devices/heartbeat-status')
  async heartbeatStatus(@Headers('authorization') authorization?: string) {
    await support(this.database, authorization);
    return (await this.staleRegisters(15)).rows;
  }

  private staleRegisters(minutes: number) {
    return this.database.query(`
      SELECT r.merchant_id AS "merchantId", m.name AS merchant, b.name AS branch, r.name AS register,
        r.id AS "registerId", h.observed_at AS "observedAt",
        (SELECT max(s.committed_at) FROM cash_sales s WHERE s.merchant_id = r.merchant_id AND s.register_id = r.id) AS "lastAcknowledgedAt"
      FROM registers r JOIN merchants m ON m.id = r.merchant_id
      JOIN branches b ON (b.merchant_id,b.id) = (r.merchant_id,r.branch_id)
      LEFT JOIN register_health h ON (h.merchant_id,h.register_id) = (r.merchant_id,r.id)
      WHERE r.status = 'active'
        AND COALESCE(h.observed_at, r.activated_at) < clock_timestamp() - make_interval(mins => $1)
      ORDER BY COALESCE(h.observed_at, r.activated_at), r.merchant_id, r.id LIMIT 100
    `, [minutes]);
  }

  @Post('platform/support/tickets')
  create(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await support(client, authorization);
      const data = record(input);
      const merchant = text(data.merchantId, 'merchant ID');
      const register = text(data.registerId, 'register ID');
      const reason = text(data.reason, 'incident reason', 500);
      const { rows } = await client.query<{ branch_id: string }>(
        'SELECT branch_id FROM registers WHERE merchant_id = $1 AND id = $2', [merchant, register],
      );
      if (!rows[0]) throw new NotFoundException();
      const target: Ticket = { id: randomUUID(), merchant_id: merchant, branch_id: rows[0].branch_id,
        register_id: register, assignee: null, resolved_at: null };
      await client.query('INSERT INTO support_tickets (id,merchant_id,branch_id,register_id) VALUES ($1,$2,$3,$4)',
        [target.id, merchant, target.branch_id, register]);
      await event(client, target, { operator }, 'opened', reason);
      return { id: target.id };
    });
  }

  @Post('platform/support/tickets/:ticketId/events')
  update(@Param('ticketId') id: string, @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await support(client, authorization);
      const data = record(input);
      const kind = data.kind;
      if (kind !== 'assigned' && kind !== 'noted' && kind !== 'resolved') throw new BadRequestException('Invalid incident action');
      const message = text(data.message, kind === 'resolved' ? 'outcome' : 'reason', 500);
      const target = await ticket(client, id);
      if (target.resolved_at) throw new ConflictException('Incident is resolved');
      if (target.assignee && target.assignee !== operator) throw new ForbiddenException('Incident is assigned to another operator');
      if (kind === 'assigned') {
        if (target.assignee) throw new ConflictException('Incident is already assigned');
        await client.query('UPDATE support_tickets SET assignee = $2 WHERE id = $1', [target.id, operator]);
      } else {
        if (!target.assignee) throw new ConflictException('Assign the incident first');
        if (kind === 'resolved') await client.query('UPDATE support_tickets SET resolved_at = now() WHERE id = $1', [target.id]);
      }
      await event(client, target, { operator }, kind, message);
      return { recorded: true };
    });
  }

  @Get('platform/support/tickets/:ticketId/history')
  platformHistory(@Param('ticketId') id: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await support(client, authorization);
      return this.history(client, await ticket(client, id));
    });
  }

  @Get('merchants/:merchantId/support/tickets')
  merchantTickets(@Param('merchantId') merchant: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await owner(client, merchant, authorization);
      const { rows } = await client.query(`${ticketListing} WHERE t.merchant_id = $1 ORDER BY t.created_at DESC LIMIT 100`, [merchant]);
      return rows;
    });
  }

  @Get('merchants/:merchantId/support/tickets/:ticketId/history')
  merchantHistory(@Param('merchantId') merchant: string, @Param('ticketId') id: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await owner(client, merchant, authorization);
      return this.history(client, await ticket(client, id, merchant));
    });
  }

  private async history(client: PoolClient, target: Ticket) {
    const events = await client.query(`
      SELECT e.id,e.kind,e.message,e.occurred_at AS "occurredAt",COALESCE(o.name,'Merchant owner') AS actor
      FROM support_events e LEFT JOIN platform_operators o ON o.id = e.operator_id
      WHERE e.ticket_id = $1 ORDER BY e.id
    `, [target.id]);
    const grants = await client.query(`
      SELECT g.id,o.name AS operator,g.reason,g.expires_at AS "expiresAt",g.revoked_at AS "revokedAt",
        (g.revoked_at IS NULL AND g.expires_at > clock_timestamp() AND t.resolved_at IS NULL
          AND t.assignee = g.operator_id) AS active
      FROM support_grants g JOIN platform_operators o ON o.id = g.operator_id JOIN support_tickets t ON t.id = g.ticket_id
      WHERE g.ticket_id = $1 ORDER BY g.granted_at DESC
    `, [target.id]);
    return { events: events.rows, grants: grants.rows };
  }

  @Post('merchants/:merchantId/support/tickets/:ticketId/grants')
  grant(@Param('merchantId') merchant: string, @Param('ticketId') id: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const member = await owner(client, merchant, authorization);
      const data = record(input);
      const reason = text(data.reason, 'approval reason', 500);
      const minutes = data.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
        throw new BadRequestException('Choose access duration from 1 to 60 minutes');
      }
      const target = await ticket(client, id, merchant);
      if (target.resolved_at || !target.assignee) throw new ConflictException('An open, assigned incident is required');
      const replaced = await client.query(`
        UPDATE support_grants SET revoked_at = clock_timestamp()
        WHERE ticket_id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
      `, [target.id]);
      if (replaced.rowCount) await event(client, target, { member }, 'revoked', 'Replaced by a new owner approval');
      const grantId = randomUUID();
      const { rows } = await client.query<{ expires_at: Date }>(`
        INSERT INTO support_grants (id,merchant_id,branch_id,ticket_id,operator_id,membership_id,reason,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp() + make_interval(mins => $8)) RETURNING expires_at
      `, [grantId, merchant, target.branch_id, target.id, target.assignee, member, reason, minutes]);
      await event(client, target, { member }, 'granted', reason);
      return { id: grantId, expiresAt: rows[0].expires_at };
    });
  }

  @Post('merchants/:merchantId/support/tickets/:ticketId/grants/:grantId/revoke')
  revoke(@Param('merchantId') merchant: string, @Param('ticketId') id: string, @Param('grantId') grantId: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const member = await owner(client, merchant, authorization);
      const target = await ticket(client, id, merchant);
      const reason = text(record(input).reason, 'revocation reason', 500);
      const key = [target.id, uuid(grantId, 'grant ID')];
      if (!(await client.query('SELECT 1 FROM support_grants WHERE ticket_id = $1 AND id = $2', key)).rowCount) throw new NotFoundException();
      const result = await client.query(
        'UPDATE support_grants SET revoked_at = clock_timestamp() WHERE ticket_id = $1 AND id = $2 AND revoked_at IS NULL', key,
      );
      if (result.rowCount) await event(client, target, { member }, 'revoked', reason);
      return { revoked: true };
    });
  }

  @Get('platform/support/tickets/:ticketId/diagnostics')
  @Header('Cache-Control', 'no-store')
  diagnostics(@Param('ticketId') id: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await support(client, authorization);
      const target = await ticket(client, id);
      if (target.resolved_at || target.assignee !== operator) throw new ForbiddenException();
      const result = await client.query(`
        SELECT r.name AS register, r.status, h.observed_at AS "observedAt", h.app_version AS "appVersion",
          h.pending_count AS pending, h.rejected_count AS rejected, h.oldest_pending_at AS "oldestPendingAt",
          (SELECT max(s.committed_at) FROM cash_sales s WHERE s.merchant_id = r.merchant_id AND s.register_id = r.id) AS "lastAcknowledgedAt"
        FROM registers r
        LEFT JOIN register_health h ON (h.merchant_id,h.register_id) = (r.merchant_id,r.id)
        WHERE (r.merchant_id,r.branch_id,r.id) = ($1,$2,$3) AND EXISTS (
          SELECT 1 FROM support_grants g WHERE g.ticket_id = $4 AND g.operator_id = $5
            AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
        )
      `, [target.merchant_id, target.branch_id, target.register_id, target.id, operator]);
      if (!result.rowCount) throw new ForbiddenException('The merchant owner must grant diagnostic access');
      await event(client, target, { operator }, 'diagnostics_viewed', 'Viewed register and sync diagnostics');
      return result.rows[0];
    });
  }
}
