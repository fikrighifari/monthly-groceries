import { createClient } from '@supabase/supabase-js';
import { triggerRestore } from './db-wake.js';

function pickEnv(...names) {
  for (const name of names) {
    const val = process.env[name]?.trim();
    if (val && !/YOUR_PROJECT_REF|your-supabase/i.test(val)) return val;
  }
  return '';
}

const supabaseUrl = pickEnv(
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'VITE_SUPABASE_URL'
);

const supabaseKey = pickEnv(
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY'
);

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        global: {
          fetch: async (url, options) => {
            const res = await fetch(url, options);
            if (!res.ok && res.status >= 500) triggerRestore();
            return res;
          },
        },
      })
    : null;

export default supabase;
