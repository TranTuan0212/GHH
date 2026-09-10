import fs from 'node:fs';
import path from 'node:path';

// Load local development settings before any route module reads process.env.
// Deployment environments can still provide variables directly; those values
// take precedence over entries in .env.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
