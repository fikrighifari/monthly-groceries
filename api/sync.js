import supabase from './_lib/db-client.js';
import prisma from './_lib/prisma.js';
import { triggerRestore } from './_lib/db-wake.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase Auth belum dikonfigurasi di server' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    if (req.method === 'GET') {
      const row = await prisma.shoppingList.findUnique({
        where: { userId: user.id },
        select: { data: true, updatedAt: true },
      });
      return res
        .status(200)
        .json(row ? { data: row.data, updated_at: row.updatedAt.toISOString() } : null);
    }

    if (req.method === 'PUT') {
      const payload = req.body?.data;
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        !payload.months ||
        typeof payload.months !== 'object' ||
        Array.isArray(payload.months)
      ) {
        return res.status(400).json({ error: 'Data daftar belanja tidak valid' });
      }
      const now = new Date();
      const row = await prisma.shoppingList.upsert({
        where: { userId: user.id },
        create: { userId: user.id, data: payload, updatedAt: now },
        update: { data: payload, updatedAt: now },
        select: { updatedAt: true },
      });
      return res.status(200).json({ updated_at: row.updatedAt.toISOString() });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sync API error:', err);
    if (err?.code === 'P1001' || err?.code === 'P1002' || err?.code === 'P1017') {
      triggerRestore();
    }
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}
