import { createClient } from 'redis';

const PARTICIPANTS_CACHE_KEY = 'participants:cache:v2';
const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

const ASSIGNED_GROUP_FIELD_ID = '7b11937f-2af8-41c9-8ed8-f38604be3ef5';
const GROUP_FIELD_NAMES = [
  'Assigned Group', 'AssignedGroup', 'Assigned group',
  'Assigned Trip', 'Assigned Trip ID', 'Trip Group',
  'Group', 'Trip', 'Trip ID', 'Taglit', 'Trip ID=Taglit',
];

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

function parseCheckbox(field) {
  if (!field) return false;
  const v = field.value;
  return v === true || v === 1 || v === '1' || v === 'true';
}

function splitMulti(value) {
  return value.split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// ── Participant mapper ────────────────────────────────────────────────────────

function mapParticipant(task) {
  const fields = task.custom_fields ?? [];
  const emailField = readFirstField(fields, ['Email', 'E-mail', 'Email Address']);
  const phoneField = readFirstField(fields, ['Phone Number', 'Phone', 'Mobile', 'Cell']);
  const sfStatusField = readFirstField(fields, ['SF Status', 'SFStatus', 'SF status']);
  const paymentStatusField = readFirstField(fields, ['Payment Status', 'PaymentStatus', 'Payment']);
  const passportStatusField = readFirstField(fields, ['Passport Status', 'PassportStatus', 'Passport status']);
  const etaIlField = readFirstField(fields, ['ETA-IL', 'ETA IL', 'ETAIL', 'eta-il']);
  const interviewStatusField = readFirstField(fields, ['Interview Status', 'InterviewStatus', 'Interview']);

  const groupFieldById = fields.find((f) => f.id === ASSIGNED_GROUP_FIELD_ID) ?? null;
  const nameMatchedCandidates = GROUP_FIELD_NAMES
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
    passportStatus: parseDropdownOrText(passportStatusField).trim(),
    passportVerified: parseDropdownOrText(passportStatusField).trim() === 'Verified',
    etaIl: parseCheckbox(etaIlField),
    interviewStatus: parseDropdownOrText(interviewStatusField).trim(),
    allFieldTexts: [],
    allRelationshipIds: [],
    assignedGroupDebug: [],
    groupLikeFieldsDebug: [],
  };
}

// ── ClickUp fetch (parallel pages) ───────────────────────────────────────────

async function fetchAllParticipants(token, listId) {
  const PAGE_SIZE = 100;

  async function fetchOnePage(page) {
    const url = `${CLICKUP_BASE}/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: token, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickUp participants fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Fetch page 0 first to get total count and first batch
  const data0 = await fetchOnePage(0);
  const page0Tasks = data0.tasks ?? [];
  console.log(`[api/refresh-participants] page=0 fetched=${page0Tasks.length}`);

  if (page0Tasks.length < PAGE_SIZE) {
    return page0Tasks.map(mapParticipant);
  }

  // ClickUp returns total_count on some plans; fall back to a safe upper bound
  const totalCount = data0.total_count ?? null;
  const totalPages = totalCount != null ? Math.ceil(totalCount / PAGE_SIZE) : 100;
  const remainingNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);

  console.log(`[api/refresh-participants] fetching pages 1–${totalPages - 1} in parallel (total_count=${totalCount ?? 'unknown'})`);

  const pageResults = await Promise.all(
    remainingNums.map(async (page) => {
      const data = await fetchOnePage(page);
      return data.tasks ?? [];
    })
  );

  const allTasks = [page0Tasks, ...pageResults.flat()];
  console.log(`[api/refresh-participants] total=${allTasks.length}`);
  return allTasks.map(mapParticipant);
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

  const listId = (process.env.CLICKUP_PARTICIPANTS_LIST_ID ?? '901811520991').trim();

  try {
    const redis = await getRedisClient();
    const allParticipants = await fetchAllParticipants(token, listId);

    const byGroup = {};
    for (const p of allParticipants) {
      for (const uuid of p.assignedGroupIds) {
        if (!byGroup[uuid]) byGroup[uuid] = [];
        byGroup[uuid].push(p);
      }
    }

    const updatedAt = new Date().toISOString();
    await redis.set(PARTICIPANTS_CACHE_KEY, JSON.stringify({ byGroup, updatedAt }));
    console.log('[api/refresh-participants] cached total=', allParticipants.length, 'groups=', Object.keys(byGroup).length);

    return res.status(200).json({
      ok: true,
      participants: allParticipants.length,
      participantGroups: Object.keys(byGroup).length,
      updatedAt,
    });
  } catch (err) {
    console.error('[api/refresh-participants] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
