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

// ── Field parsing helpers (mirrored from expo/services/clickup.ts) ────────────

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

// ── Participant helpers ───────────────────────────────────────────────────────

const PARTICIPANTS_CACHE_KEY = 'participants:cache:v1';
const PARTICIPANTS_ASSIGNED_GROUP_FIELD_ID = '7b11937f-2af8-41c9-8ed8-f38604be3ef5';
const PARTICIPANT_GROUP_FIELD_NAMES = [
  'Assigned Group', 'AssignedGroup', 'Assigned group',
  'Assigned Trip', 'Assigned Trip ID', 'Trip Group',
  'Group', 'Trip', 'Trip ID', 'Taglit', 'Trip ID=Taglit',
];

function parseCheckbox(field) {
  if (!field) return false;
  const v = field.value;
  return v === true || v === 1 || v === '1' || v === 'true';
}

function splitMulti(value) {
  return value.split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

function mapParticipant(task) {
  const fields = task.custom_fields ?? [];
  const emailField = readFirstField(fields, ['Email', 'E-mail', 'Email Address']);
  const phoneField = readFirstField(fields, ['Phone Number', 'Phone', 'Mobile', 'Cell']);
  const sfStatusField = readFirstField(fields, ['SF Status', 'SFStatus', 'SF status']);
  const paymentStatusField = readFirstField(fields, ['Payment Status', 'PaymentStatus', 'Payment']);
  const passportField = readFirstField(fields, ['Passport', 'passport']);
  const etaIlField = readFirstField(fields, ['ETA-IL', 'ETA IL', 'ETAIL', 'eta-il']);
  const interviewStatusField = readFirstField(fields, ['Interview Status', 'InterviewStatus', 'Interview']);

  const groupFieldById = fields.find((f) => f.id === PARTICIPANTS_ASSIGNED_GROUP_FIELD_ID) ?? null;
  const nameMatchedCandidates = PARTICIPANT_GROUP_FIELD_NAMES
    .map((n) => readFieldValue(fields, n))
    .filter(Boolean)
    .filter((f) => !groupFieldById || f.id !== groupFieldById.id);
  const groupFieldCandidates = groupFieldById ? [groupFieldById, ...nameMatchedCandidates] : nameMatchedCandidates;

  const relNamesParts = [];
  const dropdownParts = [];
  const idsSet = new Set();
  for (const f of groupFieldCandidates) {
    const rn = parseRelationshipNames(f);
    if (rn) relNamesParts.push(rn);
    const dt = parseDropdownOrText(f);
    if (dt) dropdownParts.push(dt);
    for (const id of parseRelationshipIds(f)) idsSet.add(id);
  }
  const relNames = relNamesParts.join(', ');
  const dropdownOrText = dropdownParts.join(', ');
  let assignedGroup = (relNames || dropdownOrText).trim();
  const assignedGroupIds = Array.from(idsSet);
  const assignedGroupValues = Array.from(new Set([...splitMulti(relNames), ...splitMulti(dropdownOrText)]));

  if (!assignedGroup) {
    for (const f of fields) {
      const text = parseRelationshipNames(f) || parseDropdownOrText(f);
      const match = splitMulti(text).find((v) => /[A-Z]{2,}-[A-Z0-9]{2,}-\d/.test(v));
      if (match) { assignedGroup = match; assignedGroupValues.push(match); break; }
    }
  }

  return {
    id: task.id,
    name: task.name?.trim() ?? '',
    email: asString(emailField?.value).trim(),
    phone: asString(phoneField?.value).trim(),
    assignedGroup: assignedGroup.trim(),
    assignedGroupValues,
    assignedGroupIds,
    status: task.status?.status ?? '',
    sfStatus: parseDropdownOrText(sfStatusField).trim(),
    paymentStatus: parseDropdownOrText(paymentStatusField).trim(),
    passport: parseCheckbox(passportField),
    etaIl: parseCheckbox(etaIlField),
    interviewStatus: parseDropdownOrText(interviewStatusField).trim(),
    allFieldTexts: [],
    allRelationshipIds: [],
    assignedGroupDebug: [],
    groupLikeFieldsDebug: [],
  };
}

async function fetchAllParticipants(token, listId) {
  const PAGE_SIZE = 100;
  const tasks = [];
  let page = 0;
  for (;;) {
    const url = `${CLICKUP_BASE}/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: token, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickUp participants fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const pageTasks = data.tasks ?? [];
    tasks.push(...pageTasks);
    console.log(`[api/refresh-staffers] participants page=${page} fetched=${pageTasks.length} total=${tasks.length}`);
    if (pageTasks.length < PAGE_SIZE) break;
    page += 1;
  }
  return tasks.map(mapParticipant);
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  // Vercel automatically sends CRON_SECRET in the Authorization header for cron invocations
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

  const participantsListId = (process.env.CLICKUP_PARTICIPANTS_LIST_ID ?? '901811520991').trim();

  try {
    const redis = await getRedisClient();

    // Refresh staffers
    const staffers = await fetchAllStaffers(token, listId);
    const staffersValue = { staffers, updatedAt: new Date().toISOString() };
    await redis.set(CACHE_KEY, JSON.stringify(staffersValue));
    console.log('[api/refresh-staffers] refreshed', staffers.length, 'staffers');

    // Refresh participants — group by assignedGroupIds UUID
    const allParticipants = await fetchAllParticipants(token, participantsListId);
    const byGroup = {};
    for (const p of allParticipants) {
      for (const uuid of p.assignedGroupIds) {
        if (!byGroup[uuid]) byGroup[uuid] = [];
        byGroup[uuid].push(p);
      }
    }
    const participantsValue = { byGroup, updatedAt: staffersValue.updatedAt };
    await redis.set(PARTICIPANTS_CACHE_KEY, JSON.stringify(participantsValue));
    console.log('[api/refresh-staffers] cached participants total=', allParticipants.length, 'groups=', Object.keys(byGroup).length);

    return res.status(200).json({
      ok: true,
      staffers: staffers.length,
      participants: allParticipants.length,
      participantGroups: Object.keys(byGroup).length,
      updatedAt: staffersValue.updatedAt,
    });
  } catch (err) {
    console.error('[api/refresh-staffers] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
