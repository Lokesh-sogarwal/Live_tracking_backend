import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Source adapters return plain row objects per legacy table. Every SQL connection is
// switched to read-only before any query: the migration never writes to the source.
// Datetimes are returned as naive strings ("YYYY-MM-DD HH:MM:SS") and converted with
// --source-tz, because the legacy columns are TIMESTAMP/DATETIME without a zone.

export async function openSource(kind, target) {
  if (kind === 'json') return jsonSource(target);
  if (kind === 'mysql') return mysqlSource(target);
  if (kind === 'postgres') return postgresSource(target);
  throw new Error(`Unknown source kind "${kind}" (use json | mysql | postgres)`);
}

function jsonSource(dir) {
  return {
    kind: 'json',
    async readTable(table) {
      try {
        return JSON.parse(await readFile(path.join(dir, `${table}.json`), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async close() {},
  };
}

async function mysqlSource(uri) {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ uri: uri.replace(/^mysql\+pymysql:/, 'mysql:'), dateStrings: true });
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  return {
    kind: 'mysql',
    async readTable(table) {
      try {
        const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
        return rows;
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return null;
        throw err;
      }
    },
    close: () => conn.end(),
  };
}

async function postgresSource(uri) {
  const pg = (await import('pg')).default;
  // Keep timestamps as strings (1114 = timestamp without time zone, 1184 = with tz, 1082 = date).
  for (const oid of [1114, 1184, 1082]) pg.types.setTypeParser(oid, (v) => v);
  const client = new pg.Client({ connectionString: uri.replace(/^postgresql\+psycopg2:/, 'postgresql:') });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  return {
    kind: 'postgres',
    async readTable(table) {
      try {
        return (await client.query(`SELECT * FROM "${table}"`)).rows;
      } catch (err) {
        if (err.code === '42P01') return null;
        throw err;
      }
    },
    close: () => client.end(),
  };
}
