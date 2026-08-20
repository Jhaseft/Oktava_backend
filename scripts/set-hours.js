// One-off: pone los 7 días 09:00-02:00 (no cerrado) en business_hours.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function readDatabaseUrl() {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const line = content.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL no encontrada en .env');
  return line.slice('DATABASE_URL='.length).trim();
}

(async () => {
  const client = new Client({ connectionString: readDatabaseUrl() });
  await client.connect();
  try {
    for (let d = 0; d < 7; d++) {
      const res = await client.query(
        'UPDATE business_hours SET is_closed = false, open_time = $1, close_time = $2 WHERE "dayOfWeek" = $3',
        ['09:00', '02:00', d],
      );
      if (res.rowCount === 0) {
        await client.query(
          'INSERT INTO business_hours (id, "dayOfWeek", is_closed, open_time, close_time) VALUES (gen_random_uuid(), $1, false, $2, $3)',
          [d, '09:00', '02:00'],
        );
  
      } else {
    
      }
    }
    const { rows } = await client.query(
      'SELECT "dayOfWeek", is_closed, open_time, close_time FROM business_hours ORDER BY "dayOfWeek"',
    );
   

  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
