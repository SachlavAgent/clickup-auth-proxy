import { createClient } from 'redis';

const CACHE_KEY = 'sachlav:staffers:cache:v1';
const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

// ── Field parsing helpers ─────────────────────────────────────────────────────

function normalizeName(name) {
  return name
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function readFieldValue(fields, name) {
  if (!fields) return null;
  const target = normalizeName(name);
  return fields.find((f) => normalizeName(f.name) === target) ?? null;
}

function readFirstField(fields, names) {
  for (const n of names) {
    const f = readFieldValue(fields, n);
    if (f) return f;
  }
  return null;
}

function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function parseDropdownOrText(field) {
  if (!field) return '';
  const raw = field.value;
  const options = field.type_config?.options;
  if (options) {
    if (typeof raw === 'string') {
      const match = options.find((o) => o.id === raw);
      if (match) return match.name;
    }
    if (typeof raw === 'number') {
      const byOrder = options.find((o) => o.orderindex === raw);
      if (byOrder) return byOrder.name;
      const byIndex = options[raw];
      if (byIndex) return byIndex.name;
    }
    if (Array.isArray(raw)) {
      const names = raw
        .map((id) => {
          if (typeof id === 'string') return options.find((o) => o.id === id)?.name;
          if (typeof id === 'number') return options.find((o) => o.orderindex === id)?.name ?? options[id]?.name;
          return undefined;
        })
        .filter(Boolean);
      if (names.length > 0) return names.join(', ');
    }
  }
  if (Array.isArray(raw)) {
    const names = raw
      .map((entry) => {
        if (entry && typeof entry === 'object' && 'name' in entry) return entry.name ?? '';
        return '';
      })
      .filter((s) => !!s);
    if (names.length > 0) return names.join(', ');
  }
  return asString(raw);
}

function parseDateIso(field) {
  if (!field || field.value === null || field.value === undefined) return '';
  const raw =
    typeof field.value === 'object' && field.value !== null && 'date' in field.value
      ? field.value.date
      : field.value;
  const num = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(num)) return '';
  return new Date(num).toISOString();
}

function parseRelationshipIds(field) {
  if (!field) return [];
  const raw = field.value;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'id' in entry) return entry.id;
      return null;
    })
    .filter((v) => typeof v === 'string');
}

function parseRelationshipNames(field) {
  if (!field) return '';
  const raw = field.value;
  if (!Array.isArray(raw)) return '';
  return raw
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'name' in entry) return entry.name ?? '';
      return '';
    })
    .filter((s) => !!s)
    .join(', ');
}

function parseRelationshipStatus(field) {
  if (!field) return '';
  const raw = field.value;
  if (!Array.isArray(raw)) return '';
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'status' in entry) {
      const s = entry.status;
      if (typeof s === 'string') return s;
      if (s && typeof s === 'object' && 'status' in s) {
        const inner = s.status;
        if (typeof inner === 'string') return inner;
      }
    }
  }
  return '';
}

// ── Staffer mapper ────────────────────────────────────────────────────────────

function mapTask(task) {
  const fields = task.custom_fields ?? [];
  const emailField = readFirstField(fields, ['Email', 'E-mail']);
  const phoneField = readFirstField(fields, ['Phone Number', 'Phone']);
  const tripIdField = readFirstField(fields, ['Trip ID', 'TripID', 'Trip Id', 'Taglit', 'Trip ID=Taglit']);
  const departureField = readFirstField(fields, ['Departure Date', 'Departure', '🛫 Departure Date']);
  const returnField = readFirstField(fields, [
    'Return Arrival Date', 'Return Date', 'Arrival Date',
    'Return/Arrival Date', '🛬 Return Arrival Date',
  ]);
  const coStaffField = readFirstField(fields, ['Co-Staff', 'Co Staff', 'CoStaff', 'Co-staff']);
  const gatewayField = readFirstField(fields, ['Gateway', 'Departure Gateway', 'Airport']);
  const genderField = readFirstField(fields, ['Gender', 'Sex', 'gender']);
  const passwordField = readFirstField(fields, ['Portal Password', 'Password', 'Staffer Password', 'Login Password']);
  const hotelNameField = readFirstField(fields, ['Hotel Name', 'Hotel', 'Hotel/Venue']);
  const hotelCityField = readFirstField(fields, ['Hotel City', 'City', 'Location City']);
  const checkInField = readFirstField(fields, ['Check-in Date', 'Check In Date', 'Checkin Date', 'Hotel Check-in']);
  const checkOutField = readFirstField(fields, ['Check-out Date', 'Check Out Date', 'Checkout Date', 'Hotel Check-out']);

  const coStaffIds = parseRelationshipIds(coStaffField);
  const coStaffText = coStaffIds.length === 0 ? parseDropdownOrText(coStaffField) : '';

  return {
    id: task.id,
    name: task.name?.trim() ?? '',
    email: asString(emailField?.value).trim(),
    phone: asString(phoneField?.value).trim(),
    tripId: parseRelationshipNames(tripIdField) || parseDropdownOrText(tripIdField),
    departureDate: parseDateIso(departureField),
    returnDate: parseDateIso(returnField),
    coStaffTaskIds: coStaffIds,
    coStaffName: coStaffText || null,
    tripTaskIds: parseRelationshipIds(tripIdField),
    status: task.status?.status ?? '',
    gateway: parseDropdownOrText(gatewayField).trim(),
    password: asString(passwordField?.value).trim(),
    hotelName: parseDropdownOrText(hotelNameField).trim(),
    hotelCity: parseDropdownOrText(hotelCityField).trim(),
    checkInDate: parseDateIso(checkInField),
    checkOutDate: parseDateIso(checkOutField),
    tripStatus: parseRelationshipStatus(tripIdField).trim(),
    gender: parseDropdownOrText(genderField).trim(),
  };
}

async function fetchAllStaffers(token, listId) {
  const pageSize = 100;
  const tasks = [];
  let page = 0;
  for (;;) {
    const url = `${CLICKUP_BASE}/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: token, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) throw new Error(`ClickUp token invalid (401): ${text.slice(0, 200)}`);
      throw new Error(`ClickUp fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    tasks.push(...(data.tasks ?? []));
    if (data.last_page || (data.tasks ?? []).length < pageSize) break;
    page += 1;
    if (page > 10) break;
  }
  return tasks.map(mapTask);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (provided !== cronSecret) return res.status(401).json({ error: 'unauthorized' });
  }

  const token = (process.env.CLICKUP_API_TOKEN ?? '').trim();
  if (!token) {
    return res.status(500).json({
      error: 'clickup_api_token_not_configured',
      message: 'Set CLICKUP_API_TOKEN in Vercel environment variables.',
    });
  }

  const listId = (process.env.CLICKUP_LIST_ID ?? process.env.CLIENT_LIST_ID ?? '').trim();
  if (!listId) {
    return res.status(500).json({
      error: 'clickup_list_id_not_configured',
      message: 'Set CLICKUP_LIST_ID (or CLIENT_LIST_ID) in Vercel environment variables.',
    });
  }

  try {
    const redis = await getRedisClient();
    const staffers = await fetchAllStaffers(token, listId);
    const updatedAt = new Date().toISOString();
    await redis.set(CACHE_KEY, JSON.stringify({ staffers, updatedAt }));
    console.log('[api/refresh-staffers] refreshed', staffers.length, 'staffers');

    return res.status(200).json({ ok: true, staffers: staffers.length, updatedAt });
  } catch (err) {
    console.error('[api/refresh-staffers] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
