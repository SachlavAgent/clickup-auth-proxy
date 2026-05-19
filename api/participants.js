import { createClient } from 'redis';

const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const ASSIGNED_GROUP_FIELD_ID = '7b11937f-2af8-41c9-8ed8-f38604be3ef5';
const PARTICIPANTS_CACHE_KEY = 'participants:cache:v1';

let redisClient = null;
async function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('[participants] Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

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

const GROUP_FIELD_NAMES = [
  'Assigned Group', 'AssignedGroup', 'Assigned group',
  'Assigned Trip', 'Assigned Trip ID', 'Trip Group',
  'Group', 'Trip', 'Trip ID', 'Taglit', 'Trip ID=Taglit',
];

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

function splitMulti(value) {
  return value
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeForMatch(s) {
  return s.replace(/\s+/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function parseCheckbox(field) {
  if (!field) return false;
  const v = field.value;
  return v === true || v === 1 || v === '1' || v === 'true';
}

// ── Participant mapper ────────────────────────────────────────────────────────

function mapParticipant(task) {
  const fields = task.custom_fields ?? [];
  const emailField = readFirstField(fields, ['Email', 'E-mail', 'Email Address']);
  const phoneField = readFirstField(fields, ['Phone Number', 'Phone', 'Mobile', 'Cell']);
  const sfStatusField = readFirstField(fields, ['SF Status', 'SFStatus', 'SF status']);
  const paymentStatusField = readFirstField(fields, ['Payment Status', 'PaymentStatus', 'Payment']);
  const passportField = readFirstField(fields, ['Passport', 'passport']);
  const etaIlField = readFirstField(fields, ['ETA-IL', 'ETA IL', 'ETAIL', 'eta-il']);
  const interviewStatusField = readFirstField(fields, ['Interview Status', 'InterviewStatus', 'Interview']);

  const groupFieldById = fields.find((f) => f.id === ASSIGNED_GROUP_FIELD_ID) ?? null;
  const nameMatchedCandidates = GROUP_FIELD_NAMES
    .map((n) => readFieldValue(fields, n))
    .filter(Boolean)
    .filter((f) => !groupFieldById || f.id !== groupFieldById.id);
  const groupFieldCandidates = groupFieldById
    ? [groupFieldById, ...nameMatchedCandidates]
    : nameMatchedCandidates;

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
  const assignedGroupValues = Array.from(new Set([
    ...splitMulti(relNames),
    ...splitMulti(dropdownOrText),
  ]));

  // Fallback: scan all fields for a trip-ID-like pattern (e.g. SA-BR-54-222)
  if (!assignedGroup) {
    for (const f of fields) {
      const text = parseRelationshipNames(f) || parseDropdownOrText(f);
      const match = splitMulti(text).find((v) => /[A-Z]{2,}-[A-Z0-9]{2,}-\d/.test(v));
      if (match) {
        assignedGroup = match;
        assignedGroupValues.push(match);
        break;
      }
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

// ── ClickUp fetch ─────────────────────────────────────────────────────────────

async function fetchAllTasks(token, listId) {
  const PAGE_SIZE = 100;
  const tasks = [];
  let page = 0;
  for (;;) {
    const url = `${CLICKUP_BASE}/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: token, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) throw new Error('ClickUp token invalid (401)');
      throw new Error(`ClickUp fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const pageTasks = data.tasks ?? [];
    tasks.push(...pageTasks);
    console.log(`[api/participants] page=${page} fetched=${pageTasks.length} total=${tasks.length}`);
    // Stop when we get a partial page — that means there are no more pages
    if (pageTasks.length < PAGE_SIZE) break;
    page += 1;
  }
  return tasks;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const token = (process.env.CLICKUP_API_TOKEN ?? '').trim();
  if (!token) {
    return res.status(500).json({ error: 'clickup_api_token_not_configured' });
  }

  const listId = (process.env.CLICKUP_PARTICIPANTS_LIST_ID ?? '901811520991').trim();
  const groupName = (req.query.groupName ?? '').trim();

  const tripTaskUuid = groupName ? (GROUP_NAME_TO_UUID[groupName] ?? null) : null;
  if (groupName && !tripTaskUuid) {
    return res.status(400).json({ error: 'unknown_group_name', groupName });
  }

  // ── Try Redis cache first ─────────────────────────────────────────────────
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(PARTICIPANTS_CACHE_KEY);
    if (cached) {
      const { byGroup } = JSON.parse(cached);
      let participants;
      if (tripTaskUuid) {
        participants = byGroup[tripTaskUuid] ?? [];
      } else {
        // Flatten all groups, deduplicate by id
        const seen = new Set();
        participants = Object.values(byGroup).flat().filter((p) => {
          if (seen.has(p.id)) return false;
          seen.add(p.id);
          return true;
        });
      }
      console.log(`[api/participants] cache hit groupName=${groupName || '(all)'} returned=${participants.length}`);
      return res.status(200).json({ participants, fromCache: true });
    }
    console.log('[api/participants] cache miss, falling back to ClickUp');
  } catch (redisErr) {
    console.warn('[api/participants] Redis unavailable, falling back to ClickUp:', redisErr.message);
  }

  // ── Fallback: fetch directly from ClickUp ─────────────────────────────────
  try {
    const tasks = await fetchAllTasks(token, listId);
    let participants = tasks.map(mapParticipant);

    if (tripTaskUuid) {
      participants = participants.filter((p) => p.assignedGroupIds.includes(tripTaskUuid));
    }

    console.log(`[api/participants] live fetch groupName=${groupName || '(all)'} returned=${participants.length}`);
    return res.status(200).json({ participants, fromCache: false });
  } catch (err) {
    console.error('[api/participants] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
