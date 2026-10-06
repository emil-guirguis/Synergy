/**
 * Persistent memory for "ask AI" chat routes, backed by Anthropic's
 * client-side memory tool (`memory_20250818`) and the framework-owned
 * public.ai_memory table (see framework/backend/db/ai_memory.sql).
 *
 * Claude sees a virtual `/memories` directory: it views/creates/edits files
 * there and this module maps each command onto ai_memory rows (one row per
 * file, keyed by path — directories are implicit from path prefixes). The API
 * itself injects the "view your memory directory first" protocol into the
 * system prompt whenever the tool is present, so a fact saved in one chat
 * ("users.qb_sales_rep_id links a portal user to a QB sales rep") is read back
 * at the start of every later chat without any extra prompting here.
 *
 * Memory is shared per tenant, not per user: tenantId scopes rows for
 * multi-tenant apps (MeterItPro); single-tenant apps (TBWC) pass null and get
 * one store for the whole portal. Return strings follow the reference
 * behaviour in Anthropic's memory tool docs, since Claude is trained on them.
 *
 * Like aiChat.ts this takes a `query` callback rather than importing an app's
 * db module, so each app routes it through its own execQuery for logging.
 */

export type AiMemoryQuery = (sql: string, params: any[]) => Promise<{ rows: any[] }>;

/** Tool name Claude uses for memory tool_use blocks — the API requires this exact name. */
export const AI_MEMORY_TOOL_NAME = 'memory';

/** The Anthropic-defined tool entry to append to a request's `tools`. No
 *  input_schema: the schema is built into the model. */
export const AI_MEMORY_CLAUDE_TOOL = { type: 'memory_20250818', name: AI_MEMORY_TOOL_NAME } as const;

/** Prompt guidance on WHAT to remember — the API-injected protocol only
 *  covers checking memory, not what belongs in it. */
export const AI_MEMORY_GUIDELINE = `You have a persistent memory directory (/memories) shared by everyone who uses this chat, kept across conversations.
SAVE, without being asked twice: anything the user tells you that would change a future answer. That includes how the data is laid out (which table or column holds a figure, how two tables link, what a business term means) AND corrections about specific records and people - how a name is actually spelled, which record someone means by a nickname or job name, that a figure lives somewhere other than you guessed. A correction the user bothered to type is exactly the thing worth keeping.
Take the instruction as the user phrases it. "Remember that", "note that", "for next time", "don't forget", or just stating the correction is a request to save it - never ask them to put it another way. Resolve what "she"/"he"/"they"/"it"/"that" refers to from earlier in THIS conversation, which you can see above, and save the fact about that person or record. If the conversation genuinely never named them, ask one short question - but do not claim you have no earlier context when the conversation above has it.
CHECK memory before telling the user something cannot be found or does not exist, and whenever they use a name, term, or abbreviation you cannot resolve - a past chat may already have recorded what it means.
Keep it to durable facts that help answer future questions, grouped into a few topic files (e.g. /memories/schema.md, /memories/business_terms.md, /memories/people.md) rather than one file per fact. Confirm what you saved, in one line. Never store passwords, API keys, or other secrets.`;

const ROOT = '/memories';
const MAX_FILE_CHARS = 20_000;
const MAX_VIEW_CHARS = 16_000;

type Scope = { tenantId: number | null };

/** Returns the normalised path, or null if it escapes /memories. */
function normalisePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let path = raw.trim();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null;
  // Reject traversal, backslashes, encoded sequences, and empty segments.
  if (/\\|%|\0/.test(path)) return null;
  const segments = path.split('/').slice(1);
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path;
}

function formatSize(chars: number): string {
  if (chars < 1024) return `${chars}`;
  return `${(chars / 1024).toFixed(1)}K`;
}

function numberLines(content: string, startLine = 1): string {
  return content
    .split('\n')
    .map((line, i) => `${String(i + startLine).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

async function getFile(query: AiMemoryQuery, scope: Scope, path: string): Promise<string | null> {
  const { rows } = await query(
    `SELECT content FROM public.ai_memory WHERE tenant_id IS NOT DISTINCT FROM $1 AND path = $2`,
    [scope.tenantId, path]
  );
  return rows.length ? (rows[0].content as string) : null;
}

async function listUnder(
  query: AiMemoryQuery,
  scope: Scope,
  dir: string
): Promise<{ path: string; size: number }[]> {
  const { rows } = await query(
    `SELECT path, length(content) AS size FROM public.ai_memory
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND left(path, length($2::text) + 1) = $2::text || '/'
      ORDER BY path`,
    [scope.tenantId, dir]
  );
  return rows.map((r) => ({ path: r.path as string, size: Number(r.size) }));
}

export interface AiMemoryFile {
  path: string;
  content: string;
  updatedAt: string;
}

/** All memory files for Settings > AI Memory — a flat, path-sorted list (no directory grouping). */
export async function listMemoryFiles(query: AiMemoryQuery, tenantId: number | null): Promise<AiMemoryFile[]> {
  const { rows } = await query(
    `SELECT path, content, updated_at FROM public.ai_memory WHERE tenant_id IS NOT DISTINCT FROM $1 ORDER BY path`,
    [tenantId]
  );
  return rows.map((r) => ({ path: r.path as string, content: r.content as string, updatedAt: r.updated_at as string }));
}

async function writeFile(query: AiMemoryQuery, scope: Scope, path: string, content: string): Promise<void> {
  await query(
    `INSERT INTO public.ai_memory (tenant_id, path, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, path) DO UPDATE SET content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP`,
    [scope.tenantId, path, content]
  );
}

async function view(query: AiMemoryQuery, scope: Scope, path: string, viewRange: unknown): Promise<string> {
  const content = path === ROOT ? null : await getFile(query, scope, path);
  if (content !== null) {
    let lines = content.split('\n');
    let start = 1;
    if (Array.isArray(viewRange) && viewRange.length === 2) {
      start = Math.max(1, Number(viewRange[0]) || 1);
      const end = Number(viewRange[1]) === -1 ? lines.length : Math.min(lines.length, Number(viewRange[1]) || lines.length);
      lines = lines.slice(start - 1, end);
    }
    let body = numberLines(lines.join('\n'), start);
    if (body.length > MAX_VIEW_CHARS) {
      body = `${body.slice(0, MAX_VIEW_CHARS)}\n... (truncated — use view_range to read the rest)`;
    }
    return `Here's the content of ${path} with line numbers:\n${body}`;
  }

  const files = await listUnder(query, scope, path);
  if (path !== ROOT && files.length === 0) {
    return `The path ${path} does not exist. Please provide a valid path.`;
  }

  // Up to 2 levels deep: files at depth 1-2, plus implied subdirectories.
  const entries = new Map<string, number>();
  const prefixDepth = path.split('/').length;
  for (const f of files) {
    const rel = f.path.split('/').slice(prefixDepth);
    if (rel.length <= 2) entries.set(f.path, f.size);
    if (rel.length > 1) {
      const sub = `${path}/${rel[0]}`;
      entries.set(sub, (entries.get(sub) ?? 0) + f.size);
    }
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const listing = [`${formatSize(total)}\t${path}`, ...[...entries].sort().map(([p, s]) => `${formatSize(s)}\t${p}`)];
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n${listing.join('\n')}`;
}

/** Executes one memory tool command; always resolves to the tool_result text. */
export async function executeMemoryCommand(
  query: AiMemoryQuery,
  tenantId: number | null,
  input: Record<string, any>
): Promise<string> {
  const scope: Scope = { tenantId };
  const command = input?.command;

  try {
    if (command === 'rename') {
      const oldPath = normalisePath(input.old_path);
      const newPath = normalisePath(input.new_path);
      if (!oldPath || !newPath) return `Error: paths must be inside ${ROOT}`;
      if (oldPath === ROOT || newPath === ROOT) return `Error: cannot rename the ${ROOT} directory itself`;

      if ((await getFile(query, scope, newPath)) !== null || (await listUnder(query, scope, newPath)).length) {
        return `Error: The destination ${newPath} already exists`;
      }
      const { rows } = await query(
        `UPDATE public.ai_memory
            SET path = $3::text || substr(path, length($2::text) + 1), updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id IS NOT DISTINCT FROM $1
            AND (path = $2 OR left(path, length($2::text) + 1) = $2::text || '/')
         RETURNING ai_memory_id`,
        [tenantId, oldPath, newPath]
      );
      if (!rows.length) return `Error: The path ${oldPath} does not exist`;
      return `Successfully renamed ${oldPath} to ${newPath}`;
    }

    const path = normalisePath(input?.path);
    if (!path) return `Error: The path ${String(input?.path)} is not inside ${ROOT}`;

    switch (command) {
      case 'view':
        return await view(query, scope, path, input.view_range);

      case 'create': {
        if (path === ROOT) return `Error: ${ROOT} is a directory`;
        const text = typeof input.file_text === 'string' ? input.file_text : '';
        if (text.length > MAX_FILE_CHARS) {
          return `Error: file_text is ${text.length} characters; memory files are capped at ${MAX_FILE_CHARS}. Split it into smaller files.`;
        }
        // Overwrite is allowed — Claude's tool description says create "creates or overwrites".
        await writeFile(query, scope, path, text);
        return `File created successfully at: ${path}`;
      }

      case 'str_replace': {
        const content = await getFile(query, scope, path);
        if (content === null) return `Error: The path ${path} does not exist. Please provide a valid path.`;
        const oldStr = typeof input.old_str === 'string' ? input.old_str : '';
        const newStr = typeof input.new_str === 'string' ? input.new_str : '';
        const occurrences = oldStr ? content.split(oldStr).length - 1 : 0;
        if (occurrences === 0) {
          return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`;
        }
        if (occurrences > 1) {
          const lineNumbers = content
            .split('\n')
            .map((line, i) => (line.includes(oldStr) ? i + 1 : 0))
            .filter(Boolean);
          return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNumbers.join(', ')}. Please ensure it is unique`;
        }
        const updated = content.replace(oldStr, () => newStr);
        if (updated.length > MAX_FILE_CHARS) return `Error: edit would exceed the ${MAX_FILE_CHARS}-character file cap`;
        await writeFile(query, scope, path, updated);
        return `The memory file has been edited.\n${numberLines(updated).slice(0, 2000)}`;
      }

      case 'insert': {
        const content = await getFile(query, scope, path);
        if (content === null) return `Error: The path ${path} does not exist`;
        const lines = content.split('\n');
        const at = Number(input.insert_line);
        if (!Number.isInteger(at) || at < 0 || at > lines.length) {
          return `Error: Invalid \`insert_line\` parameter: ${input.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`;
        }
        const text = (typeof input.insert_text === 'string' ? input.insert_text : '').replace(/\n$/, '');
        lines.splice(at, 0, text);
        const updated = lines.join('\n');
        if (updated.length > MAX_FILE_CHARS) return `Error: edit would exceed the ${MAX_FILE_CHARS}-character file cap`;
        await writeFile(query, scope, path, updated);
        return `The file ${path} has been edited.`;
      }

      case 'delete': {
        if (path === ROOT) return `Error: cannot delete the ${ROOT} directory itself`;
        const { rows } = await query(
          `DELETE FROM public.ai_memory
            WHERE tenant_id IS NOT DISTINCT FROM $1
              AND (path = $2 OR left(path, length($2::text) + 1) = $2::text || '/')
           RETURNING ai_memory_id`,
          [tenantId, path]
        );
        if (!rows.length) return `Error: The path ${path} does not exist`;
        return `Successfully deleted ${path}`;
      }

      default:
        return `Error: unknown command ${String(command)}`;
    }
  } catch (err: any) {
    return `Error: memory operation failed: ${err?.message ?? 'unknown error'}`;
  }
}
