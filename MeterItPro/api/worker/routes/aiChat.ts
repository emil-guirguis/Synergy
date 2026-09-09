/**
 * AI Chat route � Cloudflare Worker
 *
 * POST /api/ai/chat
 * Body: { message: string, history?: { role: 'user' | 'assistant', content: string }[] }
 *
 * Uses Groq (llama-3.3-70b) with tool use to answer questions about the tenant's meter data.
 * The agentic loop runs entirely inside the Worker � no external processes needed.
 */

import { Hono } from 'hono';
import OpenAI from 'openai';
import { Env, execQuery } from '../db';
import { authenticateToken, AuthVariables } from '../middleware';
import { logError } from '../errorHandler';
import { runAiChatLoop, AiChatMessage, describeAiChatError } from '@meterit/framework-backend/api/base/aiChat';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

// --- Tool definitions ---------------------------------------------------------

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_meters',
      description:
        'List all meters for this tenant. Returns meter name, location, unit, and the most recent reading value and timestamp.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of meters to return (default 50)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_meter_readings',
      description:
        'Get recent readings for a specific meter. Use this to check current consumption, look for anomalies, or compare values over time.',
      parameters: {
        type: 'object',
        properties: {
          meter_id: {
            type: 'number',
            description: 'The numeric meter_id to query',
          },
          days: {
            type: 'number',
            description: 'How many days of history to return (default 7, max 90)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of readings to return (default 100)',
          },
        },
        required: ['meter_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_notification_rules',
      description:
        'List all notification/alert rules configured for this tenant � thresholds, schedules, and which meters they monitor.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_alerts',
      description:
        'Get the most recent notification history � which rules fired, when, and whether emails were sent successfully.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of recent alerts to return (default 20)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dashboard_summary',
      description:
        'Get a high-level summary: total meters, devices, locations, readings in the last 24 hours, and any meters that have not reported recently.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

// --- Tool executor ------------------------------------------------------------

async function executeTool(
  env: Env,
  tenantId: number,
  toolName: string,
  toolInput: Record<string, any>
): Promise<string> {
  try {
    switch (toolName) {
      case 'list_meters': {
        const limit = Math.min(toolInput.limit ?? 50, 200);
        const result = await execQuery(
          env,
          `SELECT m.meter_id, m.name, m.serial_number,
                  l.name AS location_name,
                  (SELECT mr.calculated_kwh FROM meter_reading mr
                   WHERE mr.meter_id = m.meter_id
                   ORDER BY mr.created_at DESC LIMIT 1) AS latest_kwh,
                  (SELECT mr.created_at FROM meter_reading mr
                   WHERE mr.meter_id = m.meter_id
                   ORDER BY mr.created_at DESC LIMIT 1) AS latest_reading_at
           FROM meter m
           LEFT JOIN location l ON m.location_id = l.location_id
           WHERE m.tenant_id = $1 AND m.active = true
           ORDER BY m.name ASC
           LIMIT $2`,
          [tenantId, limit]
        );
        return JSON.stringify(result.rows);
      }

      case 'get_meter_readings': {
        const meterId = toolInput.meter_id;
        const days = Math.min(toolInput.days ?? 7, 90);
        const limit = Math.min(toolInput.limit ?? 100, 500);
        const meterCheck = await execQuery(
          env,
          `SELECT meter_id, name, serial_number FROM meter WHERE meter_id = $1 AND tenant_id = $2`,
          [meterId, tenantId]
        );
        if (meterCheck.rows.length === 0) {
          return JSON.stringify({ error: 'Meter not found or does not belong to this tenant' });
        }
        const result = await execQuery(
          env,
          `SELECT created_at, calculated_kwh, kwh, kw, kva, kvar, pf, amperage,
                  voltage_a_n, voltage_b_n, voltage_c_n, peak_kw
           FROM meter_reading
           WHERE meter_id = $1
             AND tenant_id = $2
             AND created_at >= NOW() - ($3 || ' days')::INTERVAL
           ORDER BY created_at DESC
           LIMIT $4`,
          [meterId, tenantId, days, limit]
        );
        return JSON.stringify({ meter: meterCheck.rows[0], readings: result.rows });
      }

      case 'list_notification_rules': {
        const result = await execQuery(
          env,
          `SELECT nr.notification_rule_id, nr.name, nr.description, nr.rule_type,
                  nr.active, nr.threshold_hours, nr.demand_threshold, nr.schedule_cron,
                  (SELECT COUNT(*) FROM notification_rule_recipient nrr
                   WHERE nrr.notification_rule_id = nr.notification_rule_id) AS recipient_count
           FROM notification_rule nr
           WHERE nr.tenant_id = $1
           ORDER BY nr.name ASC`,
          [tenantId]
        );
        return JSON.stringify(result.rows);
      }

      case 'get_recent_alerts': {
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT nh.notification_history_id, nh.title, nh.description,
                  nh.status, nh.sent_at,
                  nr.name AS rule_name, nr.rule_type
           FROM notification_history nh
           LEFT JOIN notification_rule nr ON nh.notification_rule_id = nr.notification_rule_id
           WHERE nh.tenant_id = $1
           ORDER BY nh.sent_at DESC
           LIMIT $2`,
          [tenantId, limit]
        );
        return JSON.stringify(result.rows);
      }

      case 'get_dashboard_summary': {
        const [meters, devices, locations, recentReadings, staleMeters] = await Promise.all([
          execQuery(env, `SELECT COUNT(*) AS total FROM meter WHERE tenant_id = $1`, [tenantId]),
          execQuery(env, `SELECT COUNT(*) AS total FROM device WHERE tenant_id = $1`, [tenantId]),
          execQuery(env, `SELECT COUNT(*) AS total FROM location WHERE tenant_id = $1`, [tenantId]),
          execQuery(
            env,
            `SELECT COUNT(*) AS total FROM meter_reading
             WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
            [tenantId]
          ),
          execQuery(
            env,
            `SELECT m.meter_id, m.name,
                    MAX(mr.created_at) AS last_reading
             FROM meter m
             LEFT JOIN meter_reading mr ON mr.meter_id = m.meter_id AND mr.tenant_id = m.tenant_id
             WHERE m.tenant_id = $1 AND m.active = true
             GROUP BY m.meter_id, m.name
             HAVING MAX(mr.created_at) < NOW() - INTERVAL '48 hours' OR MAX(mr.created_at) IS NULL
             ORDER BY last_reading ASC NULLS FIRST
             LIMIT 10`,
            [tenantId]
          ),
        ]);
        return JSON.stringify({
          total_meters: parseInt(meters.rows[0].total, 10),
          total_devices: parseInt(devices.rows[0].total, 10),
          total_locations: parseInt(locations.rows[0].total, 10),
          readings_last_24h: parseInt(recentReadings.rows[0].total, 10),
          stale_meters: staleMeters.rows,
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err: any) {
    logError(`[AI tool error] ${toolName}:`, err);
    return JSON.stringify({ error: err.message ?? 'Tool execution failed' });
  }
}

// --- Route --------------------------------------------------------------------

app.post('/', async (c) => {
  const tenantId = c.get('tenantId');

  if (!c.env.GROQ_API_KEY) {
    return c.json(
      { success: false, message: 'AI chat is not configured (GROQ_API_KEY missing)' },
      503
    );
  }

  let body: { message?: string; history?: { role: string; content: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid JSON body' }, 400);
  }

  const { message, history = [] } = body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return c.json({ success: false, message: 'message is required' }, 400);
  }

  const client = new OpenAI({
    apiKey: c.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const systemPrompt = `You are an AI assistant (Zenith) for MeterItPro, a facility energy management platform.
You help facility managers understand their meter data, identify issues, and make sense of their energy consumption.

You have access to tools that query the live database. Use them to answer questions accurately.
When the user asks about meters, readings, alerts, or energy usage � always fetch fresh data using the tools rather than guessing.

Guidelines:
- Be concise and actionable. Lead with the key insight, then supporting data.
- Format numbers clearly (e.g., "123.4 kWh" not "123.4234234234 kWh").
- When you spot a problem (stale meter, missed readings, high demand), mention it proactively.
- If a meter has not reported in over 48 hours, flag it as potentially offline.
- Today's date: ${new Date().toISOString().split('T')[0]}`;

  try {
    const { response, toolsUsed } = await runAiChatLoop(message, history as any, {
      systemPrompt,
      tools: TOOLS as any,
      complete: async (messages) => {
        // Groq retired llama-3.3-70b-versatile (404s as of 2026-09-09, confirmed
        // via GET /v1/models) — gpt-oss-120b is the current tool-calling model.
        const res = await client.chat.completions.create({
          model: 'openai/gpt-oss-120b',
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
          tools: TOOLS,
          tool_choice: 'auto',
        });
        return res.choices[0].message as unknown as AiChatMessage;
      },
      executeTool: (toolName, toolInput) => executeTool(c.env, tenantId, toolName, toolInput),
    });

    return c.json({ success: true, response, tools_used: toolsUsed });
  } catch (err) {
    logError('[AI_CHAT] loop failed:', err);
    const { status, message } = describeAiChatError(err);
    return c.json({ success: false, message }, status);
  }
});

export default app;
