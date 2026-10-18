'use strict';

const crypto = require('node:crypto');
const { Client } = require('pg');

const usage = () => {
  process.stderr.write('Usage: node scripts/alphasat-adapter-credential.cjs issue <organization-uuid> <label> | revoke <credential-uuid> | audit [limit]\n');
  process.exitCode = 2;
};

async function main() {
  const [action, first, second] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!['issue', 'revoke', 'audit'].includes(action) || (action !== 'audit' && !first) || (action === 'issue' && !second)) return usage();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (action === 'audit') {
      const limit = first === undefined ? 50 : Number(first);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Audit limit must be between 1 and 100');
      const result = await client.query(
        `SELECT id,action,entity_type AS "entityType",entity_id AS "credentialId",after_data AS details,created_at AS "createdAt"
         FROM audit_events
         WHERE venue_id IS NULL AND action LIKE 'alphasat.adapter.%'
         ORDER BY created_at DESC,id DESC
         LIMIT $1`,
        [limit],
      );
      process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`);
      return;
    }

    if (action === 'issue') {
      if (!/^[0-9a-f-]{36}$/i.test(first)) throw new Error('A valid organization UUID is required');
      const label = String(second).trim();
      if (!label || label.length > 120) throw new Error('Label must contain 1–120 characters');
      const credentialId = crypto.randomUUID();
      const secret = crypto.randomBytes(32).toString('base64url');
      const token = `as_hookah_${credentialId}.${secret}`;
      const tokenHash = crypto.createHash('sha256').update(secret).digest('hex');
      await client.query('BEGIN');
      const organization = await client.query('SELECT id FROM organizations WHERE id=$1 AND is_active=true', [first]);
      if (!organization.rows[0]) throw new Error('The organization does not exist or is inactive');
      await client.query(
        `INSERT INTO alphasat_adapter_credentials (id,token_hash,label,allowed_organization_id)
         VALUES ($1,$2,$3,$4)`,
        [credentialId, tokenHash, label, first],
      );
      await client.query(
        `INSERT INTO audit_events (venue_id,action,entity_type,entity_id,after_data)
         VALUES (NULL,'alphasat.adapter.credential_issued','integration_credential',$1,
           jsonb_build_object('label',$2::text,'organization_id',$3::text))`,
        [credentialId, label, first],
      );
      await client.query('COMMIT');
      process.stdout.write(`Credential ID: ${credentialId}\nOrganization ID: ${first}\nBearer token (shown once): ${token}\n`);
      return;
    }

    if (!/^[0-9a-f-]{36}$/i.test(first)) throw new Error('A valid credential UUID is required');
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE alphasat_adapter_credentials
       SET revoked_at=COALESCE(revoked_at,now())
       WHERE id=$1
       RETURNING id,allowed_organization_id AS "organizationId"`,
      [first],
    );
    if (!result.rows[0]) throw new Error('Credential not found');
    await client.query(
      `INSERT INTO audit_events (venue_id,action,entity_type,entity_id,after_data)
       VALUES (NULL,'alphasat.adapter.credential_revoked','integration_credential',$1,
         jsonb_build_object('organization_id',$2::text))`,
      [result.rows[0].id, result.rows[0].organizationId],
    );
    await client.query('COMMIT');
    process.stdout.write(`Revoked credential: ${first}\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
