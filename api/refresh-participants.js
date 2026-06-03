import { createClient } from 'redis';

const PARTICIPANTS_CACHE_KEY = 'participants:cache:v2';
const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Human-readable group name → ClickUp task UUID (shared with api/participants.js)
const GROUP_NAME_TO_UUID = {
  'SA-BR-54-333': 'cd14b78c-95c8-4bc7-a8a5-f340e6efaa4d',
  'SA-BR-54-222': '5518516a-daa1-49d0-8dd7-e5bd636010ae',
  'SA-BR-54-211': 'b866a3ee-c8fd-4fd7-944e-f8b9b7c32a96',
  'SA-BR-54-292': '92810b32-614a-46db-a4a0-6ae902607c4a',
  'SA-BR-54-178': '03e3fc1b-9521-4498-9b75-c2db0a3ead20',
  'SA-BR-54-105': '0638a5e8-6653-429a-96f4-f4a7b8d21922',
  'SA-BR-54-208': '9204f35f-cc0d-496d-98eb-1d14a33a5ea6',
  'SA-BR-54-221': 'a251d667-ab16-4ba4-a12e-8c80a43ab500',
  'SA-BR-54-328': '5fe08752-a3a4-4f4b-95bb-941878db3e2f',
  'SA-BR-54-172': '1d5665f4-d789-4e3a-a22d-72a958a59d5d',
  'SA-BR-54-54':  'a14542a6-b704-4022-8534-ebd40e411b69',
  'SA-BR-54-227': 'c63c919e-a149-4b78-b197-149eeecfd50a',
  'SA-BR-54-185': 'ba9cc7e0-aab7-4013-acd8-0c059342b7aa',
  'SA-BR-54-207': 'b7032179-87bf-47ee-81d5-a587b70e0d7d',
  'SA-BR-54-210': '50fa5065-6430-411e-b28b-ad4c5f8daa7b',
  'SA-BR-54-260': '6f232394-4af3-4bb3-a3a4-63d2d9ce13b2',
  'SA-BR-54-280': 'fc87e1dc-9886-4ff4-8bd7-588f5766dd3f',
  'SA-BR-54-539': '8f74d35a-de3e-463c-b00d-5d44b6f75e5c',
  'SA-BR-54-197': '576c61b5-50ef-4abd-937d-def425f8a785',
  'SA-BR-54-193': 'ba72512d-90a7-4eb4-8f6c-4cd8b04eef30',
  'SA-BR-54-343': '4fab959d-78c7-45dc-a99a-5704fedb157c',
  'SA-BR-54-415': '04e70763-5f08-4414-8197-57e9a18102c1',
  'SA-BR-54-337': '3d8c4ed1-8051-465a-930c-2b02c693d8dd',
  'SA-BR-54-542': 'e5429906-2f9a-42fe-bf6c-d0b6c204304a',
  'SA-BR-54-115': '10134160-31d3-4d74-8534-094f1b261823',
  'SA-BR-54-584': '50f06386-3f06-48a4-a921-532fe630e8da',
  'SA-BR-54-983': '4e77dfdd-113a-4502-819c-96112c306ba4',
  'SA-BR-54-984': '303b8adc-102a-402d-8777-cee6607bec5d',
  'SA-BR-54-21':  'd351a549-a91a-41d8-81fa-a57e0b93620d',
  'SA-BR-54-179': 'dde425cc-b3cf-4b65-9b3f-be26c9e5b4a3',
  'SA-BR-54-526': '11ba38e0-c115-452d-b514-591043367897',
};

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
  const emergencyContactsField = readFirstField(fields, ['Emergency Contacts Complete', 'Emergency Contacts']);
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
    emergencyContacts: parseCheckbox(emergencyContactsField),
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

// ── Push notification helpers ─────────────────────────────────────────────────

function diffGroups(oldByGroup, newByGroup) {
  const changes = {};
  const allUuids = new Set([...Object.keys(newByGroup), ...Object.keys(oldByGroup)]);
  for (const uuid of allUuids) {
    const oldMap = new Map((oldByGroup[uuid] ?? []).map((p) => [p.id, p]));
    const newMap = new Map((newByGroup[uuid] ?? []).map((p) => [p.id, p]));
    const additions = [...newMap.values()].filter((p) => !oldMap.has(p.id));
    const removals = [...oldMap.values()].filter((p) => !newMap.has(p.id));
    if (additions.length > 0 || removals.length > 0) {
      changes[uuid] = { additions, removals };
    }
  }
  return changes;
}

async function sendPushNotifications(redis, groupChanges) {
  // Scan all registered push tokens
  const allKeys = [];
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { MATCH: 'push:token:*', COUNT: 100 });
    cursor = result.cursor;
    allKeys.push(...result.keys);
  } while (cursor !== 0);

  if (allKeys.length === 0) return;

  // Fetch token records in parallel
  const records = await Promise.all(
    allKeys.map(async (key) => {
      const raw = await redis.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
  );

  const notifications = [];
  for (const record of records) {
    if (!record?.pushToken || !record?.groupName) continue;
    const uuid = GROUP_NAME_TO_UUID[record.groupName];
    if (!uuid || !groupChanges[uuid]) continue;

    const { additions, removals } = groupChanges[uuid];
    for (const p of additions) {
      notifications.push({
        to: record.pushToken,
        title: 'Group Update',
        body: `👋 ${p.name} has been added to your group ${record.groupName}`,
        sound: 'default',
      });
    }
    for (const p of removals) {
      notifications.push({
        to: record.pushToken,
        title: 'Group Update',
        body: `⚠️ ${p.name} has been removed from your group ${record.groupName}`,
        sound: 'default',
      });
    }
  }

  if (notifications.length === 0) return;
  console.log(`[api/refresh-participants] sending ${notifications.length} push notifications`);

  // Expo push API accepts batches of up to 100
  for (let i = 0; i < notifications.length; i += 100) {
    const batch = notifications.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      const result = await res.json();
      console.log('[api/refresh-participants] push batch result:', JSON.stringify(result).slice(0, 500));
    } catch (err) {
      console.error('[api/refresh-participants] push batch error:', err.message);
    }
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

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

    // Read existing cache before overwriting so we can diff for push notifications
    let oldByGroup = null;
    try {
      const oldCached = await redis.get(PARTICIPANTS_CACHE_KEY);
      if (oldCached) {
        oldByGroup = JSON.parse(oldCached).byGroup ?? null;
      }
    } catch (err) {
      console.warn('[api/refresh-participants] could not read old cache for diff:', err.message);
    }

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

    // Diff and notify only when there was a previous cache to compare against
    let notificationsSent = 0;
    if (oldByGroup) {
      const groupChanges = diffGroups(oldByGroup, byGroup);
      const changedCount = Object.keys(groupChanges).length;
      console.log(`[api/refresh-participants] groups with changes: ${changedCount}`);
      if (changedCount > 0) {
        await sendPushNotifications(redis, groupChanges);
        notificationsSent = changedCount;
      }
    }

    return res.status(200).json({
      ok: true,
      participants: allParticipants.length,
      participantGroups: Object.keys(byGroup).length,
      groupsWithChanges: notificationsSent,
      updatedAt,
    });
  } catch (err) {
    console.error('[api/refresh-participants] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
