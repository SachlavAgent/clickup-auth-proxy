const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const ASSIGNED_GROUP_FIELD_ID = '7b11937f-2af8-41c9-8ed8-f38604be3ef5';

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

// ── Participant mapper ────────────────────────────────────────────────────────

function mapParticipant(task) {
  const fields = task.custom_fields ?? [];
  const emailField = readFirstField(fields, ['Email', 'E-mail', 'Email Address']);
  const phoneField = readFirstField(fields, ['Phone Number', 'Phone', 'Mobile', 'Cell']);

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
    allFieldTexts: [],
    allRelationshipIds: [],
    assignedGroupDebug: [],
    groupLikeFieldsDebug: [],
  };
}

// ── ClickUp fetch ─────────────────────────────────────────────────────────────

async function fetchAllTasks(token, listId) {
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
      if (res.status === 401) throw new Error('ClickUp token invalid (401)');
      throw new Error(`ClickUp fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    tasks.push(...(data.tasks ?? []));
    if (data.last_page || (data.tasks ?? []).length < pageSize) break;
    page += 1;
    if (page > 20) break;
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
  const groupId = (req.query.groupId ?? '').trim();

  try {
    const tasks = await fetchAllTasks(token, listId);
    let participants = tasks.map(mapParticipant);

    if (groupId) {
      const targetKey = normalizeForMatch(groupId);
      participants = participants.filter((p) => {
        const candidates = [p.assignedGroup, ...p.assignedGroupValues]
          .map(normalizeForMatch)
          .filter((c) => c.length > 0);
        return candidates.some((c) => c === targetKey);
      });
    }

    console.log(`[api/participants] listId=${listId} groupId=${groupId || '(all)'} returned=${participants.length}`);
    return res.status(200).json({ participants });
  } catch (err) {
    console.error('[api/participants] error:', err);
    return res.status(500).json({ error: 'internal_server_error', message: err.message });
  }
}
